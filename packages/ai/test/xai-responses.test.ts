import { afterEach, describe, expect, it, vi } from "vitest";
import { getModels, getSupportedThinkingLevels } from "../src/models.js";
import { streamOpenAIResponses } from "../src/providers/openai-responses.js";
import type { Api, Model } from "../src/types.js";
import { XAI_SUBSCRIPTION_MODEL_IDS, xaiOAuthProvider } from "../src/utils/oauth/xai.js";

type CapturedRequest = {
	url: string;
	headers: Headers;
	body: Record<string, unknown>;
};

type CaptureOptions = {
	apiKey: string;
	sessionId?: string;
	cacheRetention?: "none" | "short" | "long";
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
};

function completedResponse(): Response {
	const event = {
		type: "response.completed",
		sequence_number: 0,
		response: {
			id: "resp_xai_test",
			status: "completed",
			output: [],
			usage: {
				input_tokens: 1,
				output_tokens: 1,
				total_tokens: 2,
				input_tokens_details: { cached_tokens: 0 },
			},
		},
	};
	return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

async function captureRequest(model: Model<"openai-responses">, options: CaptureOptions): Promise<CapturedRequest> {
	let captured: CapturedRequest | undefined;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input, init);
		captured = {
			url: request.url,
			headers: request.headers,
			body: JSON.parse(await request.clone().text()) as Record<string, unknown>,
		};
		return completedResponse();
	});

	const stream = streamOpenAIResponses(
		model,
		{
			systemPrompt: "You are a careful coding assistant.",
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
		},
		options,
	);

	let stopReason: string | undefined;
	for await (const event of stream) {
		if (event.type === "done") {
			stopReason = event.message.stopReason;
			break;
		}
		if (event.type === "error") break;
	}
	expect(stopReason, `stream failed: ${JSON.stringify(captured)}`).toBe("stop");
	expect(captured).toBeDefined();
	return captured!;
}

/** grok-4.5 as the subscription-modified model (openai-responses). */
function grok45ResponsesModel(): Model<"openai-responses"> {
	return {
		id: "grok-4.5",
		name: "Grok 4.5",
		api: "openai-responses",
		provider: "xai",
		baseUrl: "https://api.x.ai/v1",
		compat: { supportsLongCacheRetention: false },
		reasoning: true,
		thinkingLevelMap: { off: null, minimal: null },
		input: ["text", "image"],
		cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
		contextWindow: 500000,
		maxTokens: 500000,
	};
}

describe("xAI OAuth model routing", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("exposes the subscription model allowlist", () => {
		expect(XAI_SUBSCRIPTION_MODEL_IDS).toEqual(["grok-4.5", "grok-4.6"]);
	});

	it("routes grok-4.5 and grok-4.6 to openai-responses and drops other xai models", () => {
		const xaiModels = getModels("xai") as Model<Api>[];
		// The catalog may not list grok-4.6 yet; synthesize it from grok-4.5 when missing.
		const grok46CompletionsModel: Model<Api> | undefined = xaiModels.some((m) => m.id === "grok-4.6")
			? undefined
			: {
					...xaiModels.find((m) => m.id === "grok-4.5")!,
					id: "grok-4.6",
					name: "Grok 4.6",
				};
		const openaiModel = getModels("openai")[0] as Model<Api>;
		const anthropicModel = getModels("anthropic")[0] as Model<Api>;
		const input = [
			...xaiModels,
			...(grok46CompletionsModel ? [grok46CompletionsModel] : []),
			openaiModel,
			anthropicModel,
		];

		const result = xaiOAuthProvider.modifyModels!(input, {
			access: "access-token",
			refresh: "refresh-token",
			expires: 0,
		});

		const grok45 = result.find((m) => m.id === "grok-4.5");
		const grok46 = result.find((m) => m.id === "grok-4.6");
		expect(grok45).toBeDefined();
		expect(grok45!.api).toBe("openai-responses");
		expect(grok45!.compat).toEqual({ supportsLongCacheRetention: false });
		expect(grok45!.thinkingLevelMap).toMatchObject({ off: null, minimal: null });
		expect(grok46).toBeDefined();
		expect(grok46!.api).toBe("openai-responses");
		expect(grok46!.compat).toEqual({ supportsLongCacheRetention: false });

		for (const m of xaiModels) {
			if (XAI_SUBSCRIPTION_MODEL_IDS.includes(m.id)) continue;
			expect(result.some((r) => r.id === m.id)).toBe(false);
		}

		// Non-xAI models are untouched.
		expect(result).toContain(openaiModel);
		expect(result).toContain(anthropicModel);
	});

	it("keeps only low/medium/high thinking levels on the routed grok-4.5", () => {
		expect(getSupportedThinkingLevels(grok45ResponsesModel())).toEqual(["low", "medium", "high"]);
	});

	it("routes grok-4.5 through /responses with bearer auth and xAI-compatible request fields", async () => {
		const captured = await captureRequest(grok45ResponsesModel(), {
			apiKey: "xai-test-token",
			sessionId: "pi-session-123",
			cacheRetention: "long",
			reasoningEffort: "medium",
		});

		expect(captured.url).toBe("https://api.x.ai/v1/responses");
		expect(captured.headers.get("authorization")).toBe("Bearer xai-test-token");
		expect(captured.headers.get("session_id")).toBe("pi-session-123");
		expect(captured.body).toMatchObject({
			model: "grok-4.5",
			store: false,
			stream: true,
			prompt_cache_key: "pi-session-123",
			reasoning: { effort: "medium" },
			include: ["reasoning.encrypted_content"],
		});
		expect(captured.body).not.toHaveProperty("prompt_cache_retention");
		expect(captured.body.input).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: "developer",
					content: "You are a careful coding assistant.",
				}),
			]),
		);
	});

	it("requests encrypted reasoning content even when no reasoning effort is given", async () => {
		const captured = await captureRequest(grok45ResponsesModel(), {
			apiKey: "xai-test-token",
			sessionId: "pi-session-123",
		});

		expect(captured.body).toMatchObject({
			include: ["reasoning.encrypted_content"],
		});
	});
});
