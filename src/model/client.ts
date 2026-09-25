// Model calls with live, record and replay modes. Record writes one transcript per (stage, idea):
// the ordered list of assistant messages. Replay returns them in order, so a recorded stage call
// re-runs deterministically and for free against replayed search fixtures.
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { modelCostUsd, sha256, type Mode, type Stage } from "../config.js";

export class BudgetExceededError extends Error {}

/** An API failure that will not clear on retry or on the next task: exhausted credits, bad key, no permission. The run must stop. */
export class FatalApiError extends Error {}

export function isFatalApiError(e: unknown): boolean {
  if (!(e instanceof Anthropic.APIError)) return false;
  if (e.status === 401 || e.status === 403) return true;
  return e.status === 400 && /credit balance|billing|purchase credits/i.test(e.message);
}

export class ModelFixtureMissingError extends Error {
  constructor(stage: string, ideaId: string, index: number, file: string) {
    super(`no recorded model response #${index} for ${stage}/${ideaId} (${path.relative(process.cwd(), file)})`);
  }
}

export interface ModelCallResult {
  message: Anthropic.Messages.Message;
  costUsd: number;
  source: "live" | "fixture";
  /** Replay only: the request differed from the one recorded at this position. */
  digestMismatch: boolean;
}

export interface ModelSession {
  call(params: Anthropic.Messages.MessageCreateParamsNonStreaming): Promise<ModelCallResult>;
}

export interface ModelClient {
  readonly mode: Mode;
  session(stage: Stage, ideaId: string, fixtureName?: string): ModelSession;
  liveSpendUsd(): number;
}

export interface ModelClientOptions {
  mode: Mode;
  fixtureDir: string;
  onSpend?: (usd: number, what: string) => void;
  client?: Anthropic;
  /** Record mode only: replay a recorded response when the transcript already has one at this position, and go live otherwise. Used to resume an interrupted recording. */
  reuseExisting?: boolean;
  /** Extra retries on connection errors on top of the SDK's own. Default 3, waiting 5s, 15s, 45s. */
  connectionRetries?: number;
}

interface RecordedCall {
  index: number;
  request_digest: string;
  usage: Anthropic.Messages.Usage;
  cost_usd: number;
  response: Anthropic.Messages.Message;
}

interface Transcript {
  stage: Stage;
  idea_id: string;
  model: string;
  recorded_at: string;
  calls: RecordedCall[];
}

/** Fixture name for sample s of an idea: A07.s1, A07.s2, ... */
export function sampleFixtureName(ideaId: string, sample: number): string {
  return `${ideaId}.s${sample}`;
}

export function modelFixturePath(fixtureDir: string, stage: Stage, name: string): string {
  return path.join(fixtureDir, "model", stage, `${name}.json`);
}

function digest(params: Anthropic.Messages.MessageCreateParamsNonStreaming): string {
  return sha256(JSON.stringify(params));
}

export function createModelClient(opts: ModelClientOptions): ModelClient {
  let liveSpend = 0;
  let anthropic: Anthropic | null = opts.client ?? null;
  const getClient = () => {
    if (!anthropic) {
      if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set (required for live and record modes)");
      // Keys that are not scoped to a workspace must send the workspace id on every request.
      const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID;
      anthropic = new Anthropic(workspaceId ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } } : {});
    }
    return anthropic;
  };

  const retries = opts.connectionRetries ?? 3;
  async function createWithRetry(params: Anthropic.Messages.MessageCreateParamsNonStreaming): Promise<Anthropic.Messages.Message> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await getClient().messages.create(params);
      } catch (e) {
        if (isFatalApiError(e)) throw new FatalApiError(e instanceof Error ? e.message : String(e));
        const retryable = e instanceof Anthropic.APIConnectionError || (e instanceof Anthropic.APIError && (e.status === 429 || (e.status ?? 0) >= 500));
        if (!retryable || attempt >= retries) throw e;
        await new Promise((r) => setTimeout(r, 5000 * 3 ** attempt));
      }
    }
  }

  async function live(params: Anthropic.Messages.MessageCreateParamsNonStreaming): Promise<{ message: Anthropic.Messages.Message; costUsd: number }> {
    const message = await createWithRetry(params);
    const costUsd = modelCostUsd(params.model, message.usage);
    liveSpend += costUsd;
    opts.onSpend?.(costUsd, `model:${params.model}`);
    return { message, costUsd };
  }

  return {
    mode: opts.mode,
    liveSpendUsd: () => liveSpend,
    session(stage, ideaId, fixtureName = ideaId) {
      const file = modelFixturePath(opts.fixtureDir, stage, fixtureName);
      let index = 0;
      let transcript: Transcript | null = null;

      if (opts.mode === "replay") {
        if (!fs.existsSync(file)) {
          return {
            async call() {
              throw new ModelFixtureMissingError(stage, ideaId, 0, file);
            },
          };
        }
        transcript = JSON.parse(fs.readFileSync(file, "utf8")) as Transcript;
      }
      if (opts.mode === "record" && opts.reuseExisting && fs.existsSync(file)) {
        transcript = JSON.parse(fs.readFileSync(file, "utf8")) as Transcript;
      }

      return {
        async call(params) {
          const i = index++;
          if (opts.mode === "replay") {
            const rec = transcript!.calls[i];
            if (!rec) throw new ModelFixtureMissingError(stage, ideaId, i, file);
            return { message: rec.response, costUsd: rec.cost_usd, source: "fixture", digestMismatch: rec.request_digest !== digest(params) };
          }
          if (opts.mode === "record" && opts.reuseExisting) {
            const rec = transcript?.calls[i];
            if (rec && rec.response?.stop_reason) return { message: rec.response, costUsd: rec.cost_usd, source: "fixture", digestMismatch: rec.request_digest !== digest(params) };
          }
          const { message, costUsd } = await live(params);
          if (opts.mode === "record") {
            if (!transcript) transcript = { stage, idea_id: ideaId, model: params.model, recorded_at: new Date().toISOString(), calls: [] };
            transcript.calls = transcript.calls.slice(0, i);
            transcript.calls.push({ index: i, request_digest: digest(params), usage: message.usage, cost_usd: costUsd, response: message });
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, JSON.stringify(transcript, null, 2) + "\n");
          }
          return { message, costUsd, source: "live", digestMismatch: false };
        },
      };
    },
  };
}
