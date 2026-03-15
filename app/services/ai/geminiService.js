const DEFAULT_GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_GEMINI_MODEL = 'gemini-1.5-flash';

const normalizeModelName = (value, fallback = DEFAULT_GEMINI_MODEL) => {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  return raw.startsWith('models/') ? raw.slice('models/'.length) : raw;
};

const toPositiveInt = (value, fallback, min = 1) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return parsed;
};

const parseErrorMessage = (payload, status) => {
  const explicit = String(payload?.error?.message || '').trim();
  if (explicit) return explicit;
  return `Gemini API retornou status ${status}.`;
};

const extractTextFromCandidate = (candidate) => {
  const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
  const chunks = [];
  for (const part of parts) {
    const text = String(part?.text || '').trim();
    if (text) chunks.push(text);
  }
  return chunks.join('\n').trim();
};

const normalizeOutboundText = (value) =>
  String(value || '')
    .split('\0')
    .join('')
    .trim();

export const createGeminiTextService = ({ apiKey = process.env.GEMINI_API_KEY, defaultModel = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL, timeoutMs = 25_000, apiBaseUrl = process.env.GEMINI_API_BASE_URL || DEFAULT_GEMINI_API_BASE_URL } = {}) => {
  const safeApiKey = String(apiKey || '').trim();
  if (!safeApiKey) return null;

  if (typeof globalThis.fetch !== 'function') {
    throw new Error('createGeminiTextService: global fetch indisponivel no runtime atual.');
  }

  const safeBaseUrl =
    String(apiBaseUrl || DEFAULT_GEMINI_API_BASE_URL)
      .trim()
      .replace(/\/+$/, '') || DEFAULT_GEMINI_API_BASE_URL;
  const safeTimeoutMs = Math.max(1_000, toPositiveInt(timeoutMs, 25_000, 1_000));
  const resolvedDefaultModel = normalizeModelName(defaultModel, DEFAULT_GEMINI_MODEL);

  const generateText = async ({ instructions = '', userPrompt = '', model = resolvedDefaultModel } = {}) => {
    const safePrompt = normalizeOutboundText(userPrompt);
    if (!safePrompt) return { text: '', model: normalizeModelName(model, resolvedDefaultModel) };

    const modelName = normalizeModelName(model, resolvedDefaultModel);
    const encodedModelName = encodeURIComponent(modelName);
    const endpoint = `${safeBaseUrl}/models/${encodedModelName}:generateContent?key=${encodeURIComponent(safeApiKey)}`;
    const payload = {
      contents: [
        {
          role: 'user',
          parts: [{ text: safePrompt }],
        },
      ],
    };

    const safeInstructions = normalizeOutboundText(instructions);
    if (safeInstructions) {
      payload.systemInstruction = {
        role: 'system',
        parts: [{ text: safeInstructions }],
      };
    }

    const controller = typeof globalThis.AbortController === 'function' ? new globalThis.AbortController() : null;
    const timeoutHandle = controller
      ? setTimeout(() => {
          controller.abort(new Error(`Gemini generateContent excedeu ${safeTimeoutMs}ms`));
        }, safeTimeoutMs)
      : null;

    try {
      // lgtm[js/file-access-to-http]
      const response = await globalThis.fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        // lgtm[js/file-access-to-http]
        body: JSON.stringify(payload),
        signal: controller?.signal,
      });

      const responsePayload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(parseErrorMessage(responsePayload, response.status));
      }

      const candidates = Array.isArray(responsePayload?.candidates) ? responsePayload.candidates : [];
      const text = candidates.map((candidate) => extractTextFromCandidate(candidate)).find(Boolean) || '';
      return {
        text,
        model: modelName,
      };
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  };

  return {
    defaultModel: resolvedDefaultModel,
    generateText,
  };
};
