/**
 * omptmem — OptMem (github.com/VictorTaelin/OptMem) coupled into omp.
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
import { Text } from "@oh-my-pi/pi-tui";

const MEMO = (process.env.OPTMEM_MEMO || "~/.optmem/memo").replace(/^~(?=\/|$)/, os.homedir());
const MEMORY_DIR = (process.env.MEMORY_DIR || "~/.optmem/memory").replace(/^~(?=\/|$)/, os.homedir());
/** memo's fixed log record width (LOG_REC): LOG.txt size / this = memory count. */
const LOG_RECORD_BYTES = 320;
const EXEC_TIMEOUT_MS = 30_000;
/** wake pages at ~20 KB; this bounds a runaway loop, not a real memory. */
const MAX_WAKE_PARTS = 64;
/** One drain answers at most this many compressions; the next trigger resumes. */
const MAX_NAPS_PER_DRAIN = 256;
/** How long shutdown waits for an in-flight compression to land. */
const SHUTDOWN_DRAIN_MS = 20_000;
const NOTHING_PENDING = "Nothing left to compress.";
const NAP_ROLES = ["@optmem", "@smol"];
const TOOL_NAMES = ["memo_note", "memo_recall", "memo_zoom", "memo_forget"];
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

/** Drop the compression request memo appends after `note`/`wake`: the worker answers it. */
function withoutNapRequest(out: string): string {
	const at = out.search(/^Compress memories #/m);
	return at < 0 ? out : out.slice(0, at).trimEnd();
}

export default function omptmem(pi: ExtensionAPI) {
	let snapshot: WakeSnapshot | undefined;
	let ready: Promise<void> = Promise.resolve();
	let naps: Promise<void> = Promise.resolve();
	let napState = "";
	const sessionNotes: string[] = [];

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
		ctx.ui.setStatus("optmem", `mem ${Math.floor(size / LOG_RECORD_BYTES)}${napState && ` · ${napState}`}`);
	}

	// ------------------------------------------------------------ compression worker

	/** Answer one memo compression request with the nap model; returns the line. */
	async function compress(ctx: ExtensionContext, request: string, limit: number): Promise<string> {
		const model = NAP_ROLES.map(role => ctx.models.resolve(role)).find(Boolean) ?? ctx.models.current();
		if (!model) throw new Error("no model available for OptMem compression");
		const sessionId = ctx.sessionManager.getSessionId();
		const messages: Parameters<typeof completeSimple>[1]["messages"] = [
			{ role: "user", content: [{ type: "text", text: request }], timestamp: Date.now() },
		];
		for (let attempt = 0; attempt < 2; attempt++) {
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
				pi.logger.debug("optmem: compressed", { model: `${model.provider}/${model.id}`, bytes });
				return line;
			}
			messages.push(reply, {
				role: "user",
				content: [{ type: "text", text: `That was ${bytes} bytes. Reply with one line of at most ${limit} bytes.` }],
				timestamp: Date.now(),
			});
		}
		throw new Error(`${model.id} could not compress within ${limit} bytes`);
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
			const saved = await memo(["nap", id, await compress(ctx, request, limit)]);
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
		if (r.code === 0 && NAP_TRIGGERS[args[0]!]) void scheduleNaps(ctx);
		if (r.code === 0 && args[0] === "note") {
			sessionNotes.push(args[1]!);
			await updateStatus(ctx);
		}
		const out = withoutNapRequest(r.out) || "(no output)";
		return { ...text(out), details: { args, code: r.code }, isError: r.code !== 0 };
	}

	/** One-line call and result views; the full output shows when expanded. */
	function view(verb: string, argOf: (args: Record<string, string>) => string) {
		return {
			renderCall: (args: Record<string, string>, _o: unknown, theme: { fg(c: string, s: string): string; bold(s: string): string }) =>
				new Text(`${theme.fg("toolTitle", theme.bold(`memo ${verb} `))}${theme.fg("muted", argOf(args))}`, 0, 0),
			renderResult: (
				result: { content: { type: string; text?: string }[]; isError?: boolean },
				options: { expanded: boolean; isPartial: boolean },
				theme: { fg(c: string, s: string): string },
			) => {
				if (options.isPartial) return new Text(theme.fg("muted", "…"), 0, 0);
				const out = result.content.map(b => b.text ?? "").join("\n").trim();
				const lines = out.split("\n");
				const shown = options.expanded ? out : lines.length > 1 ? `${lines.at(-1)}  (${lines.length} lines)` : out;
				return new Text(theme.fg(result.isError ? "error" : "success", shown), 0, 0);
			},
		};
	}

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
		...view("note", a => a.text ?? ""),
	});

	pi.registerTool({
		name: "memo_recall",
		label: "Memo Recall",
		description: "Search every OptMem memory ever recorded, word for word, by case-insensitive Python regex.",
		parameters: T.Object({ regex: T.String({ description: "Python regex, case-insensitive" }) }),
		loadMode: "essential",
		approval: "read",
		execute: (_id, p, signal, _u, ctx) => run(["recall", p.regex], signal, ctx),
		...view("recall", a => `/${a.regex ?? ""}/`),
	});

	pi.registerTool({
		name: "memo_zoom",
		label: "Memo Zoom",
		description: "Open an OptMem tree node (#a-b) into its two halves: summaries, or raw memories once single.",
		parameters: T.Object({ id: blockId }),
		loadMode: "essential",
		approval: "read",
		execute: (_id, p, signal, _u, ctx) => run(["zoom", p.id], signal, ctx),
		...view("zoom", a => `#${a.id ?? ""}`),
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
		...view("forget", a => `#${a.id ?? ""}`),
	});

	// ------------------------------------------------------------ command

	pi.registerCommand("memo", {
		description: "Run OptMem: /memo wake|note|nap|recall|zoom|forget|config|init [args]",
		handler: async (raw, ctx) => {
			const args = splitArgs(raw);
			const r = await memo(args[0] === "help" ? [] : args);
			if (r.code === 0 && args[0] === "init") startRefresh(ctx);
			else if (r.code === 0 && NAP_TRIGGERS[args[0] ?? ""]) void scheduleNaps(ctx);
			pi.sendMessage(
				{ customType: "optmem", content: `$ memo ${raw.trim()}\n${r.out || "(no output)"}`, display: true, attribution: "user" },
				{ triggerTurn: false },
			);
			if (r.code !== 0) ctx.ui.notify(`memo ${args[0] ?? ""} failed (exit ${r.code})`, "error");
		},
	});
}
