/**
 * omp-optmem — OptMem (github.com/VictorTaelin/OptMem) coupled into omp. Its Pi
 * counterpart is the pi-optmem repo; both drive the same `memo` script.
 *
 * OptMem stays the single source of truth: every read and write goes through
 * its `memo` script, so sessions running under other harnesses share the same
 * memory. This extension replaces the pasted AGENTS.md block with:
 *   - auto-wake: `memo wake` (all parts) is run at session start and after
 *     compaction, and the result is placed in the system prompt;
 *   - native tools (memo_note, memo_recall, memo_zoom, memo_forget) instead of
 *     shelling out through bash;
 *   - background compression: pending `memo nap` requests are answered by the
 *     `optmem` model role (falling back to `smol`, then the session model),
 *     never by the main agent;
 *   - compaction awareness: the summarizer is told what OptMem already holds;
 *   - the subagent rule enforced: subagents get no memo tools and cannot run
 *     memo through bash or eval;
 *   - compact tool rendering, a status-line entry, and `/memo <command>`.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { completeSimple } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { type AutocompleteItem, type Component, Text, visibleWidth } from "@oh-my-pi/pi-tui";
import { item, list } from "@oh-my-pi/pi-tui/native/describe";
import { plainText } from "@oh-my-pi/pi-tui/native/spans";
import {
	createCachedComponent,
	Ellipsis,
	formatExpandHint,
	PREVIEW_LIMITS,
	renderStatusLine,
	replaceTabs,
	truncateToWidth,
} from "@oh-my-pi/pi-tui/render";
import { wrapPrefixedLine } from "@oh-my-pi/pi-tui/render/hanging-wrap";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import type { NativeToolView } from "@oh-my-pi/pi-tui/tools";
import { errorView, resultText, toolHead } from "@oh-my-pi/pi-tui/tools/native-view";

const MEMO = (process.env.OPTMEM_MEMO || "~/.optmem/memo").replace(/^~(?=\/|$)/, os.homedir());
const MEMORY_DIR = (process.env.MEMORY_DIR || "~/.optmem/memory").replace(/^~(?=\/|$)/, os.homedir());
/** memo's fixed log record width (LOG_REC): LOG.txt size / this = memory count. */
const LOG_RECORD_BYTES = 320;
const EXEC_TIMEOUT_MS = 30_000;
/** wake pages at ~20 KB; this bounds a runaway loop, not a real memory. */
const MAX_WAKE_PARTS = 64;
/** One drain answers at most this many compressions; the next trigger resumes. */
const MAX_NAPS_PER_DRAIN = 256;
/**
 * How long shutdown waits for an in-flight compression to land. omp cuts
 * session_shutdown handlers at 2 s and reports a timeout error, so stay under it.
 */
const SHUTDOWN_DRAIN_MS = 1_500;
const NOTHING_PENDING = "Nothing left to compress.";
const NAP_ROLES = ["@optmem", "@smol"];
/** Model tries per compression before the shortest reply is cut to fit. */
const NAP_ATTEMPTS = 4;
/** Asked-for size as a share of the hard limit: models miscount bytes. */
const NAP_TARGET_RATIO = 0.8;
const TOOL_NAMES = ["memo_note", "memo_recall", "memo_zoom", "memo_forget"];
/** `/memo` subcommands offered by argument completion; `usage` is the ghost-text hint. */
const SUBCOMMANDS: Record<string, { usage?: string; description: string }> = {
	recall: { usage: "<regex>", description: "search every memory ever recorded, by regex" },
	zoom: { usage: "<lo>-<hi>", description: "open a tree node into its two halves" },
	note: { usage: '"<one line>"', description: "record one memory: one short line" },
	forget: { usage: "<lo>-<hi>", description: "drop a bad summary; it is rebuilt in the background" },
	config: { usage: "[NAME=N]", description: "show this memory's sizes, or change one" },
	wake: { description: "read the memory (all parts are already in the system prompt)" },
	nap: { description: "show the pending compressions (the worker answers them)" },
	init: { description: "create the memory" },
	import: { usage: "<file>", description: "bulk-load dated memories from a file (bootstrap only)" },
	help: { description: "show memo usage" },
};
/** Block ids offered while completing `/memo zoom|forget`. */
const MAX_BLOCK_COMPLETIONS = 64;
/** memo commands that can leave compressions pending. */
const NAP_TRIGGERS: Record<string, true> = { init: true, note: true, forget: true, import: true };
/** A shell or Python invocation of the memo script, by path or bare name. */
const MEMO_INVOCATION = /(?:optmem\/memo\b|(?:^|[\s;&|(`'"])memo\s+(?:init|wake|note|nap|recall|zoom|forget|config|import)\b)/;
const NAP_SYSTEM_PROMPT = `You compress the permanent memories of an AI coding agent.
Reply with exactly one line: the compressed memory, nothing else. No quotes, no
preamble, no markdown. Keep what has lasting effect: decisions, facts about the
user, preferences, outcomes, names, paths, dates that matter. Drop what does not.
Invent nothing. Stay within the byte limit you are given.`;

interface MemoRun {
	code: number;
	out: string;
}

type WakeSnapshot =
	| { kind: "awake"; text: string }
	| { kind: "blocked"; text: string }
	| { kind: "missing"; text: string };

/** Split `/memo` arguments like a shell would for simple quoting. */
function splitArgs(input: string): string[] {
	const args: string[] = [];
	const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
	for (const m of input.matchAll(re)) {
		args.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : (m[2] ?? m[3]!));
	}
	return args;
}

function text(t: string) {
	return { content: [{ type: "text" as const, text: t }] };
}

/**
 * Drop the compression instructions memo appends after `note`/`forget`/`wake`
 * (the request block, or forget's trailing `Run: memo nap`): the worker answers them.
 */
function withoutNapRequest(out: string): string {
	const at = out.search(/^Compress memories #/m);
	return (at < 0 ? out : out.slice(0, at)).replace(/\s*Run: \S*memo nap\s*$/, "").trimEnd();
}

/** Cut `line` to at most `limit` UTF-8 bytes, at the last space that fits when there is one. */
function cutToBytes(line: string, limit: number): string {
	const buf = Buffer.from(line);
	if (buf.length <= limit) return line;
	// Back off continuation bytes so no character is split.
	let end = limit;
	while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
	const head = buf.subarray(0, end).toString();
	const space = head.lastIndexOf(" ");
	return (space > head.length / 2 ? head.slice(0, space) : head).replace(/[\s,;:(-]+$/, "");
}

// ------------------------------------------------------------ rendering

/** A memo reply split for display: a short header fact, then rows under it. */
interface MemoView {
	meta?: string;
	rows: string[];
	/** Rows shown while collapsed. */
	preview: number;
	warn?: boolean;
}

type ToolResultView = { content: { type: string; text?: string }[]; isError?: boolean };

/** Header plus rows, clamped to `preview` while collapsed and word-wrapped when expanded. */
function memoLines(
	header: string,
	view: MemoView,
	expanded: boolean,
	width: number,
	theme: Theme,
	style: { bullet: boolean; color: "toolOutput" | "error" },
): string[] {
	const lines = [truncateToWidth(header, width, Ellipsis.Unicode)];
	const shown = expanded ? view.rows : view.rows.slice(0, view.preview);
	const prefix = style.bullet ? `  ${theme.fg("muted", theme.format.bullet)} ` : "  ";
	const hang = " ".repeat(visibleWidth(prefix));
	for (const row of shown) {
		const value = theme.fg(style.color, replaceTabs(row));
		if (expanded) lines.push(...wrapPrefixedLine(prefix, hang, value, width));
		else lines.push(truncateToWidth(`${prefix}${value}`, width, Ellipsis.Unicode));
	}
	const hidden = view.rows.length - shown.length;
	if (hidden > 0) {
		lines.push(
			truncateToWidth(`  ${theme.fg("dim", `… ${hidden} more`)} ${formatExpandHint(theme, expanded, true)}`, width, Ellipsis.Omit),
		);
	}
	return lines;
}

/**
 * Renderers matching omp's built-in memory tools: one status line (pending, then
 * the memory glyph, or a warning/error icon) that the result replaces in place,
 * rows under it, and the semantic view for TSP terminals and HTML export.
 */
function memoToolView<A>(title: string, describe: (args: A) => string, parse: (out: string, args?: A) => MemoView) {
	const subject = (args: A | undefined) => {
		const s = args ? replaceTabs(describe(args).trim()) : "";
		return s ? truncateToWidth(s, 80, Ellipsis.Unicode) : undefined;
	};
	return {
		// Read by omp at runtime (copied onto the tool adapter); not in ToolDefinition's typings.
		mergeCallAndResult: true,
		renderCall: (args: A, _options: unknown, theme: Theme): Component =>
			new Text(renderStatusLine({ icon: "pending", title, description: subject(args) }, theme), 0, 0),
		renderResult: (result: ToolResultView, options: { expanded: boolean }, theme: Theme, args?: A): Component => {
			const out = resultText(result).trim();
			const failed = result.isError === true;
			const view: MemoView = failed ? { rows: out.split("\n"), preview: Infinity } : parse(out, args);
			const header = renderStatusLine(
				{
					icon: failed ? "error" : view.warn ? "warning" : undefined,
					iconOverride: failed || view.warn ? undefined : theme.styledSymbol("tool.memory", "accent"),
					title,
					description: subject(args),
					meta: view.meta ? [view.meta] : undefined,
				},
				theme,
			);
			const style = { bullet: !failed, color: failed ? ("error" as const) : ("toolOutput" as const) };
			return createCachedComponent(
				() => options.expanded,
				(width, expanded) => memoLines(header, view, expanded, width, theme, style),
			);
		},
		describeCall: (args: A): NativeToolView => ({ head: toolHead(title, subject(args)), inline: true }),
		describeResult: (result: ToolResultView, _options: unknown, args?: A): NativeToolView => {
			const out = resultText(result).trim();
			if (result.isError) return { ...errorView(title, out, subject(args)), inline: true };
			const view = parse(out, args);
			return {
				head: toolHead(title, subject(args), view.meta),
				tone: view.warn ? "warning" : undefined,
				inline: true,
				body: view.rows.length ? [list(view.rows.map((row, i) => item(String(i), { label: plainText(row) })))] : [],
				preview: { lines: view.preview },
			};
		},
	};
}

export default function ompOptmem(pi: ExtensionAPI) {
	let snapshot: WakeSnapshot | undefined;
	let ready: Promise<void> = Promise.resolve();
	let naps: Promise<void> = Promise.resolve();
	let napState = "";
	const sessionNotes: string[] = [];
	/** Memory count as of the last status update. */
	let memoryCount = 0;
	/** Built summaries seen in wake/zoom output, `lo-hi` → text: completion labels and forget targets. */
	const summaries = new Map<string, string>();
	/** `memo config` rows, `NAME` → `value  meaning`. */
	const knobs = new Map<string, string>();

	function rememberSummaries(out: string): void {
		for (const m of out.matchAll(/^#(\d+-\d+) (.+)$/gm)) {
			if (m[2] !== "not compressed yet") summaries.set(m[1]!, m[2]!);
		}
	}

	/** Keep completion state in step with what memo printed. */
	function observe(args: string[], r: MemoRun): void {
		if (r.code !== 0) return;
		const [cmd, arg] = args;
		if (cmd === "zoom") rememberSummaries(r.out);
		if (cmd === "config") {
			for (const m of r.out.matchAll(/^([A-Z_]+)\s+(\d+)\s+(.+)$/gm)) knobs.set(m[1]!, `${m[2]}  ${m[3]}`);
		}
		if (cmd === "forget" && arg) {
			// forget drops the block and every summary built on it: each block containing it.
			const [lo = 0, hi = 0] = arg.split("-").map(Number);
			for (const id of summaries.keys()) {
				const [a = 0, b = 0] = id.split("-").map(Number);
				if (a <= lo && b >= hi) summaries.delete(id);
			}
		}
	}

	/** `/memo` completion: subcommands, then block ids (from this memory) and config names. */
	function completeArgs(prefix: string): AutocompleteItem[] | null {
		const space = prefix.indexOf(" ");
		if (space < 0) {
			const typed = prefix.toLowerCase();
			const items = Object.entries(SUBCOMMANDS)
				.filter(([name]) => name.startsWith(typed))
				.map(([name, s]) => ({
					value: `${name} `,
					label: name,
					description: s.description,
					hint: name.slice(typed.length) + (s.usage ? ` ${s.usage}` : "") || undefined,
				}));
			return items.length ? items : null;
		}
		const sub = prefix.slice(0, space).toLowerCase();
		const arg = prefix.slice(space + 1);
		if (/\s/.test(arg)) return null;
		const items: AutocompleteItem[] = [];
		if (sub === "zoom" || sub === "forget") {
			const want = arg.replace(/^#/, "");
			const offer = (id: string) => {
				if (items.length >= MAX_BLOCK_COMPLETIONS || !id.startsWith(want) || items.some(i => i.label === `#${id}`)) return;
				const [lo = 0, hi = 0] = id.split("-").map(Number);
				const held = Math.min(hi + 1, memoryCount) - lo;
				items.push({ value: `${sub} ${id}`, label: `#${id}`, description: summaries.get(id) ?? `${held} memories, not compressed yet` });
			};
			// Summaries wake printed first, as the agent sees them; zoom reaches any block.
			for (const id of summaries.keys()) offer(id);
			if (sub === "zoom") {
				for (let size = 2 ** Math.ceil(Math.log2(Math.max(2, memoryCount))); size >= 2; size /= 2) {
					for (let lo = 0; lo < memoryCount && items.length < MAX_BLOCK_COMPLETIONS; lo += size) offer(`${lo}-${lo + size - 1}`);
				}
			}
		} else if (sub === "config") {
			const name = arg.split("=")[0]!.toUpperCase();
			for (const [knob, about] of knobs) {
				if (knob.startsWith(name)) items.push({ value: `config ${knob}=`, label: knob, description: about });
			}
		}
		return items.length ? items : null;
	}

	async function memo(args: string[], signal?: AbortSignal): Promise<MemoRun> {
		const r = await pi.exec(MEMO, args, { timeout: EXEC_TIMEOUT_MS, signal });
		const out = [r.stdout.trimEnd(), r.stderr.trimEnd()].filter(Boolean).join("\n");
		if (r.killed) return { code: r.code || 1, out: out || `memo ${args[0]} timed out or was aborted.` };
		return { code: r.code, out };
	}

	/** Read every wake part at one snapshot T, as the footer instructs. */
	async function wake(signal?: AbortSignal): Promise<WakeSnapshot> {
		const parts: string[] = [];
		let args = ["wake"];
		for (let i = 0; i < MAX_WAKE_PARTS; i++) {
			const r = await memo(args, signal);
			if (r.code !== 0) {
				if (/^No memory at /m.test(r.out)) return { kind: "missing", text: r.out };
				return { kind: "blocked", text: [...parts, r.out].join("\n") };
			}
			const next = r.out.match(/^Not awake yet\. Run: .* wake (\d+) (\d+)\s*$/m);
			if (!next) {
				parts.push(withoutNapRequest(r.out));
				return { kind: "awake", text: parts.join("\n") };
			}
			parts.push(r.out.slice(0, next.index).trimEnd());
			args = ["wake", next[1]!, next[2]!];
		}
		return { kind: "blocked", text: `${parts.join("\n")}\nwake did not finish after ${MAX_WAKE_PARTS} parts.` };
	}

	async function updateStatus(ctx: ExtensionContext): Promise<void> {
		const size = await fs.stat(path.join(MEMORY_DIR, "LOG.txt")).then(s => s.size, () => undefined);
		if (size === undefined) return ctx.ui.setStatus("optmem", undefined);
		memoryCount = Math.floor(size / LOG_RECORD_BYTES);
		if (!ctx.hasUI) return;
		// Styled like a status-line segment: glyph and value in one colour (the
		// memory tools' accent), extra facts after the theme's dot separator.
		const t = ctx.ui.theme;
		let status = t.fg("accent", `${t.symbol("tool.memory")} ${memoryCount}`);
		if (sessionNotes.length) status += ` ${t.fg("success", `+${sessionNotes.length}`)}`;
		if (napState === "nap failed") status += t.fg("statusLineSep", t.sep.dot) + t.fg("error", `${t.symbol("status.error")} ${napState}`);
		else if (napState) status += t.fg("statusLineSep", t.sep.dot) + t.fg("warning", `${t.symbol("status.pending")} ${napState}`);
		ctx.ui.setStatus("optmem", status);
	}

	// ------------------------------------------------------------ compression worker

	/**
	 * Answer one memo compression request with the nap model; returns the line.
	 * Models miscount bytes, so it asks for less than the limit, tells the model
	 * how far over each reply went, and after NAP_ATTEMPTS cuts the shortest reply
	 * at a word boundary: a stuck block would otherwise stop every later compression.
	 */
	async function compress(ctx: ExtensionContext, request: string, limit: number): Promise<string> {
		const model = NAP_ROLES.map(role => ctx.models.resolve(role)).find(Boolean) ?? ctx.models.current();
		if (!model) throw new Error("no model available for OptMem compression");
		const sessionId = ctx.sessionManager.getSessionId();
		const target = Math.floor(limit * NAP_TARGET_RATIO);
		const messages: Parameters<typeof completeSimple>[1]["messages"] = [
			{
				role: "user",
				content: [{ type: "text", text: `${request}\n\nAim for about ${target} bytes; ${limit} is the hard limit.` }],
				timestamp: Date.now(),
			},
		];
		let shortest = "";
		for (let attempt = 0; attempt < NAP_ATTEMPTS; attempt++) {
			const reply = await completeSimple(
				model,
				{ systemPrompt: [NAP_SYSTEM_PROMPT], messages },
				{
					apiKey: ctx.modelRegistry.resolver(model, sessionId),
					sessionId,
					maxTokens: 1024,
					disableReasoning: true,
					temperature: 0,
				},
			);
			if (reply.stopReason === "error") throw new Error(reply.errorMessage || `${model.id} failed`);
			const raw = reply.content.flatMap(b => (b.type === "text" ? [b.text] : [])).join("");
			const line = (raw.split("\n").find(l => l.trim()) ?? "").trim().replace(/^["'`]|["'`]$/g, "").trim();
			const bytes = Buffer.byteLength(line);
			if (line && bytes <= limit) {
				pi.logger.debug("optmem: compressed", { model: `${model.provider}/${model.id}`, bytes, attempt });
				return line;
			}
			if (line && (!shortest || bytes < Buffer.byteLength(shortest))) shortest = line;
			messages.push(reply, {
				role: "user",
				content: [
					{
						type: "text",
						text: line
							? `That was ${bytes} bytes, ${bytes - limit} over the ${limit}-byte limit. Rewrite it in at most ${target} bytes: drop the least important details and abbreviate. One line.`
							: `Reply with the compressed memory: one line of at most ${target} bytes.`,
					},
				],
				timestamp: Date.now(),
			});
		}
		if (!shortest) throw new Error(`${model.id} returned no compression`);
		const cut = cutToBytes(shortest, limit);
		pi.logger.warn("optmem: compression cut to fit", { model: `${model.provider}/${model.id}`, from: Buffer.byteLength(shortest), to: Buffer.byteLength(cut) });
		return cut;
	}

	/** Answer every pending compression, smallest block first, as memo orders them. */
	async function drain(ctx: ExtensionContext): Promise<void> {
		for (let i = 0; i < MAX_NAPS_PER_DRAIN; i++) {
			const next = await memo(["nap"]);
			if (next.code !== 0) throw new Error(next.out);
			if (next.out.trim() === NOTHING_PENDING) break;
			const id = next.out.match(/ nap (\d+-\d+) "<your line>"\s*$/m)?.[1];
			const limit = Number(next.out.match(/at most (\d+) bytes/)?.[1]);
			if (!id || !limit) throw new Error(`unrecognized memo nap output:\n${next.out}`);
			const remaining = Number(next.out.match(/^(\d+) compressions? remains?/m)?.[1] ?? 0);
			napState = `napping ${remaining + 1}`;
			await updateStatus(ctx);
			const request = next.out.replace(/^Run: .*$/m, "").trim();
			const line = await compress(ctx, request, limit);
			const saved = await memo(["nap", id, line]);
			if (saved.code === 0) summaries.set(id, line);
			// A parallel session may have answered the same block first; the loop
			// then simply asks memo for the next one.
			if (saved.code !== 0 && !/settled/.test(saved.out)) throw new Error(saved.out);
		}
		napState = "";
		await updateStatus(ctx);
	}

	/** Queue a drain behind any running one; failures surface to the user, never throw. */
	function scheduleNaps(ctx: ExtensionContext): Promise<void> {
		naps = naps.then(() =>
			drain(ctx).catch(async (error: unknown) => {
				napState = "nap failed";
				await updateStatus(ctx);
				ctx.ui.notify(`OptMem compression failed (${NAP_ROLES.join(" → ")} → session model): ${String(error)}`, "error");
			}),
		);
		return naps;
	}

	async function refresh(ctx: ExtensionContext): Promise<void> {
		let s = await wake();
		if (s.kind === "blocked") {
			// wake refuses only when its document needs a summary not yet built.
			await scheduleNaps(ctx);
			s = await wake();
		} else if (s.kind === "awake") {
			// Work the document does not need is compressed after the read.
			void scheduleNaps(ctx);
		}
		snapshot = s;
		if (s.kind === "awake") {
			summaries.clear();
			rememberSummaries(s.text);
		}
		observe(["config"], await memo(["config"]));
		if (s.kind === "missing") {
			ctx.ui.notify(`OptMem: no memory at ${MEMORY_DIR}. Run /memo init to create one.`, "warning");
		}
		await updateStatus(ctx);
	}

	function startRefresh(ctx: ExtensionContext): void {
		if (ctx.agent.kind !== "main") return;
		ready = refresh(ctx).catch((error: unknown) => {
			snapshot = { kind: "blocked", text: String(error) };
			ctx.ui.notify(`OptMem wake failed: ${String(error)}`, "error");
		});
	}

	function promptBlock(s: WakeSnapshot): string {
		const state =
			s.kind === "awake"
				? "Below is your memory, read at session start (the output of `memo wake`). You are awake."
				: "Your memory could not be loaded this session; the reason is below. Tell the user, and keep recording memories with memo_note.";
		return `# Memory (OptMem)

Your permanent memory is OptMem: tool \`${MEMO}\`, memories in \`${MEMORY_DIR}\`.
It outlives every session, compaction, model and vendor change. Without it you
do not know who you are, or what was decided and tried. The user's other agents
share it.

${state}

## Tools — use these, never bash, for memory
- memo_note(text): record one memory, one line of at most 280 bytes, without a
  date (memo stamps it). Call it
  whenever you learn something new or something worth keeping happens: a task
  worth real effort, a fact or insight the user teaches you, anything you learn
  about their life (even indirectly), any event of lasting effect. Do not
  register redundant memories.
- memo_recall(regex): search every memory ever recorded, word for word.
- memo_zoom(id): open a tree node \`#a-b\` into its two halves, down to the raw
  memories. Every \`#a-b\` line below is a node: #0-1, #2-3 summarize pairs,
  #0-3 pairs of those, and so on.
- memo_forget(id): drop a bad summary; it is rebuilt automatically.

Compressions (\`memo nap\`) are answered automatically in the background; never
do them yourself. Never edit or delete anything under \`${MEMORY_DIR}\`.

Subagents are not you: they get no memory tools. When you spawn one, do not
ask it to record or read memories; record what matters from its result yourself.

<optmem-wake>
${s.text}
</optmem-wake>`;
	}

	// ------------------------------------------------------------ lifecycle

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.agent.kind !== "main") {
			// The subagent rule: a child cannot judge what is already known, so
			// its notes would arrive duplicated and wrong.
			const active = pi.getActiveTools().filter(name => !TOOL_NAMES.includes(name));
			await pi.setActiveTools(active);
			return;
		}
		startRefresh(ctx);
		// omp's own memory (memory.backend) would run a second, unrelated store
		// beside OptMem: two recall paths and two prompt blocks to keep in sync.
		void ctx.memory
			?.status()
			.then(s => {
				if (s.active && s.backend !== "off") {
					ctx.ui.notify(
						`OptMem: omp's memory.backend is "${s.backend}" too; set it to "off" so memories live in one place.`,
						"warning",
					);
				}
			})
			.catch((error: unknown) => pi.logger.debug("optmem: memory backend status failed", { error: String(error) }));
	});

	// The system prompt is rebuilt from a snapshot only when the context is
	// replaced anyway, so the prompt-cache prefix stays stable between turns.
	pi.on("session_compact", async (_event, ctx) => startRefresh(ctx));
	pi.on("session_switch", async (_event, ctx) => startRefresh(ctx));

	pi.on("session.compacting", async (_event, ctx) => {
		if (ctx.agent.kind !== "main" || snapshot?.kind !== "awake") return;
		const notes = sessionNotes.length
			? `Memories recorded in OptMem during this session (already persisted):\n${sessionNotes.map(n => `- ${n}`).join("\n")}`
			: "No memories were recorded in OptMem during this session.";
		return {
			context: [
				"The agent has a permanent memory (OptMem) that is re-read into its system prompt after this compaction. Do not restate durable facts about the user, past decisions, or preferences that it already holds; spend the summary on the current task state.",
				notes,
			],
		};
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		await ready;
		if (!snapshot || snapshot.kind === "missing") return;
		return { systemPrompt: [...event.systemPrompt, promptBlock(snapshot)] };
	});

	pi.on("tool_call", async (event, ctx) => {
		if (ctx.agent.kind === "main") return;
		const input = event.input as { command?: unknown; code?: unknown };
		const source = event.toolName === "bash" ? input.command : event.toolName === "eval" ? input.code : undefined;
		if (typeof source === "string" && MEMO_INVOCATION.test(source)) {
			return { block: true, reason: "You are a subagent. Don't run memo: OptMem belongs to the main agent." };
		}
	});

	pi.on("session_shutdown", async () => {
		// Let an in-flight compression land; whatever is left, the next session drains.
		const timeout = Promise.withResolvers<void>();
		setTimeout(timeout.resolve, SHUTDOWN_DRAIN_MS).unref();
		await Promise.race([naps, timeout.promise]);
	});

	// ------------------------------------------------------------ tools

	async function run(args: string[], signal: AbortSignal | undefined, ctx: ExtensionContext) {
		if (ctx.agent.kind !== "main") {
			return { ...text("You are a subagent. Don't run memo."), isError: true };
		}
		const r = await memo(args, signal);
		observe(args, r);
		if (r.code === 0 && NAP_TRIGGERS[args[0]!]) void scheduleNaps(ctx);
		if (r.code === 0 && args[0] === "note") {
			sessionNotes.push(args[1]!);
			await updateStatus(ctx);
		}
		const out = withoutNapRequest(r.out) || "(no output)";
		return { ...text(out), details: { args, code: r.code }, isError: r.code !== 0 };
	}

	const noteSubject = (a: { text: string }) => a.text;

	// pi.zod schemas infer `unknown` params through registerTool in 18.12.x typings; the TypeBox shim infers.
	const T = pi.typebox.Type;
	const blockId = T.String({ pattern: "^\\d+-\\d+$", description: "A block id as printed by memo, like 16-31 (no #)" });

	pi.registerTool({
		name: "memo_note",
		label: "Memo Note",
		description:
			"Record one permanent OptMem memory: a single line, at most 280 bytes. Do not include a date: memo stamps it. Compression is handled in the background.",
		parameters: T.Object({ text: T.String({ description: "The memory: one line, at most 280 bytes, no date prefix" }) }),
		loadMode: "essential",
		approval: "write",
		execute: (_id, p, signal, _u, ctx) => run(["note", p.text], signal, ctx),
		...memoToolView("Memo Note", noteSubject, (out, a) => {
			const id = out.match(/^Saved as (#\d+)\./)?.[1];
			// The header clips the note at 80 columns; expanding shows all of it.
			const long = a !== undefined && visibleWidth(noteSubject(a)) > 80;
			return { meta: id && `saved ${id}`, rows: long ? [noteSubject(a)] : id ? [] : [out], preview: 0 };
		}),
	});

	pi.registerTool({
		name: "memo_recall",
		label: "Memo Recall",
		description: "Search every OptMem memory ever recorded, word for word, by case-insensitive Python regex.",
		parameters: T.Object({ regex: T.String({ description: "Python regex, case-insensitive" }) }),
		loadMode: "essential",
		approval: "read",
		execute: (_id, p, signal, _u, ctx) => run(["recall", p.regex], signal, ctx),
		...memoToolView(
			"Memo Recall",
			(a: { regex: string }) => `/${a.regex}/`,
			out => {
				const rows = out.split("\n");
				const tally = rows.at(-1)?.match(/^(\d+ match(?:es)?|No match)\.$/)?.[1];
				if (tally) rows.pop();
				return { meta: tally?.toLowerCase(), rows, preview: PREVIEW_LIMITS.COLLAPSED_LINES, warn: tally === "No match" };
			},
		),
	});

	pi.registerTool({
		name: "memo_zoom",
		label: "Memo Zoom",
		description: "Open an OptMem tree node (#a-b) into its two halves: summaries, or raw memories once single.",
		parameters: T.Object({ id: blockId }),
		loadMode: "essential",
		approval: "read",
		execute: (_id, p, signal, _u, ctx) => run(["zoom", p.id], signal, ctx),
		...memoToolView(
			"Memo Zoom",
			(a: { id: string }) => `#${a.id}`,
			out => ({ rows: out.split("\n"), preview: PREVIEW_LIMITS.COLLAPSED_LINES }),
		),
	});

	pi.registerTool({
		name: "memo_forget",
		label: "Memo Forget",
		description:
			"Drop a bad OptMem summary and every summary built on it; they are rebuilt in the background. The raw log is never touched.",
		parameters: T.Object({ id: blockId }),
		loadMode: "essential",
		approval: "write",
		execute: (_id, p, signal, _u, ctx) => run(["forget", p.id], signal, ctx),
		...memoToolView(
			"Memo Forget",
			(a: { id: string }) => `#${a.id}`,
			out => {
				const [first = "", ...rest] = out.split("\n");
				return { meta: first.replace(/\.$/, "").replace(/^Forgot/, "forgot"), rows: rest, preview: 0 };
			},
		),
	});

	// ------------------------------------------------------------ command

	/** `/memo` output in the transcript: the command as a status line, output under it. */
	pi.registerMessageRenderer<{ args: string[]; code: number; output: string }>("optmem", (message, options, theme) => {
		const d = message.details;
		if (!d) return undefined;
		const header = renderStatusLine(
			{
				icon: d.code ? "error" : undefined,
				iconOverride: d.code ? undefined : theme.styledSymbol("tool.memory", "accent"),
				title: "memo",
				description: d.args.join(" ") || "help",
				meta: d.code ? [`exit ${d.code}`] : undefined,
			},
			theme,
		);
		const view: MemoView = { rows: d.output ? d.output.split("\n") : [], preview: PREVIEW_LIMITS.EXPANDED_LINES };
		const style = { bullet: false, color: d.code ? ("error" as const) : ("toolOutput" as const) };
		return createCachedComponent(
			() => options.expanded,
			(width, expanded) => memoLines(header, view, expanded, width, theme, style),
		);
	});

	pi.registerCommand("memo", {
		description: "Run OptMem: /memo wake|note|nap|recall|zoom|forget|config|init [args]",
		getArgumentCompletions: completeArgs,
		handler: async (raw, ctx) => {
			const args = splitArgs(raw);
			const r = await memo(args[0] === "help" ? [] : args);
			observe(args, r);
			if (r.code === 0 && args[0] === "init") startRefresh(ctx);
			else if (r.code === 0 && NAP_TRIGGERS[args[0] ?? ""]) void scheduleNaps(ctx);
			// `nap` is asked for its pending request; elsewhere the worker answers it.
			// init's AGENTS.md setup block is what this extension replaces.
			const output = (args[0] === "nap" ? r.out : withoutNapRequest(r.out))
				.replace(/\n+Paste this at the top of your agent's AGENTS\.md[\s\S]*$/, "")
				.trimEnd();
			pi.sendMessage(
				{
					customType: "optmem",
					content: `$ memo ${raw.trim()}\n${output || "(no output)"}`,
					details: { args, code: r.code, output },
					display: true,
					attribution: "user",
				},
				{ triggerTurn: false },
			);
			if (r.code !== 0) ctx.ui.notify(`memo ${args[0] ?? ""} failed (exit ${r.code})`, "error");
		},
	});
}
