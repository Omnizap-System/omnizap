import fs from 'node:fs/promises';
import path from 'node:path';
import OpenAI from 'openai';
import { getAiHelpCachedResponse, upsertAiHelpCachedResponse } from './aiHelpResponseCacheRepository.js';
import { createGeminiTextService, DEFAULT_GEMINI_MODEL } from './geminiService.js';

const DEFAULT_FAQ_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_RESPONSE_CHARS = 3400;
const DEFAULT_MAX_AGENT_CONTEXT_CHARS = 12000;
const DEFAULT_TIMEOUT_MS = 25000;
const DEFAULT_OPENAI_MODEL = 'gpt-5-nano';
const CACHE_SCOPE_QUESTION = 'question';
const CACHE_SCOPE_COMMAND_EXPLAIN = 'command_explain';

const normalizeText = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s/_.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const defaultLogger = {
  info: (...args) => console.info(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
  debug: (...args) => console.debug(...args),
};

const ensureArray = (value) => (Array.isArray(value) ? value.filter(Boolean) : []);
const ensureObject = (value) => (value && typeof value === 'object' ? value : {});
const pickFirstText = (...values) => {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
};
const pickFirstBoolean = (...values) => {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
  }
  return false;
};

const formatPermissionLabel = (permission) => String(permission || 'nao definido').trim();

const formatWhereLabel = (contexts = []) => {
  if (!Array.isArray(contexts) || contexts.length === 0) return 'nao definido';
  return contexts.join(', ');
};

const readEntryDescription = (entry = {}) => pickFirstText(entry?.description, entry?.docs?.summary, entry?.descricao);

const readEntryUsage = (entry = {}) => {
  const usageV2 = ensureArray(entry?.usage);
  if (usageV2.length) return usageV2;
  const docsUsage = ensureArray(entry?.docs?.usage_examples);
  if (docsUsage.length) return docsUsage;
  return ensureArray(entry?.metodos_de_uso);
};

const readEntryPermission = (entry = {}) => pickFirstText(entry?.permission, entry?.permissao_necessaria);

const readEntryContexts = (entry = {}) => {
  const contextsV2 = ensureArray(entry?.contexts);
  if (contextsV2.length) return contextsV2;
  return ensureArray(entry?.local_de_uso);
};

const readEntryUsageLimit = (entry = {}) => pickFirstText(entry?.limits?.usage_description, entry?.limite_de_uso);

const readEntryRequirements = (entry = {}) => {
  const requirements = ensureObject(entry?.requirements);
  const requirementsLegacy = ensureObject(requirements?.legacy);
  const preConditions = ensureObject(entry?.pre_condicoes);

  return {
    require_group: pickFirstBoolean(requirements.require_group, requirements.requer_grupo, requirementsLegacy.require_group, requirementsLegacy.requer_grupo, preConditions.requer_grupo),
    require_group_admin: pickFirstBoolean(requirements.require_group_admin, requirements.requer_admin, requirementsLegacy.require_group_admin, requirementsLegacy.requer_admin, preConditions.requer_admin),
    require_bot_owner: pickFirstBoolean(requirements.require_bot_owner, requirements.requer_admin_principal, requirementsLegacy.require_bot_owner, requirementsLegacy.requer_admin_principal, preConditions.requer_admin_principal),
    require_google_login: pickFirstBoolean(requirements.require_google_login, requirements.requer_google_login, requirementsLegacy.require_google_login, requirementsLegacy.requer_google_login, preConditions.requer_google_login),
    require_nsfw_enabled: pickFirstBoolean(requirements.require_nsfw_enabled, requirements.requer_nsfw, requirementsLegacy.require_nsfw_enabled, requirementsLegacy.requer_nsfw, preConditions.requer_nsfw),
    require_media: pickFirstBoolean(requirements.require_media, requirements.requer_midia, requirementsLegacy.require_media, requirementsLegacy.requer_midia, preConditions.requer_midia),
    require_reply_message: pickFirstBoolean(requirements.require_reply_message, requirements.requer_mensagem_respondida, requirementsLegacy.require_reply_message, requirementsLegacy.requer_mensagem_respondida, preConditions.requer_mensagem_respondida),
  };
};

const formatPreConditions = (requirements = {}) => {
  const lines = [];
  if (requirements.require_group) lines.push('- Requer ser executado em grupo.');
  if (requirements.require_group_admin) lines.push('- Requer permissao de admin do grupo.');
  if (requirements.require_bot_owner) lines.push('- Requer admin principal do bot.');
  if (requirements.require_google_login) lines.push('- Pode requerer login vinculado ao site.');
  if (requirements.require_nsfw_enabled) lines.push('- Requer NSFW ativo quando aplicavel.');
  if (requirements.require_media) lines.push('- Requer midia anexada/citada quando aplicavel.');
  if (requirements.require_reply_message) lines.push('- Requer resposta/citacao de mensagem quando aplicavel.');
  if (lines.length === 0) lines.push('- Sem pre-condicoes explicitas no modulo.');
  return lines;
};

const evaluatePreConditions = (entry, context = {}) => {
  const requirements = readEntryRequirements(entry);
  const reasons = [];

  if (requirements.require_group && !context.isGroupMessage) {
    reasons.push('este comando exige uso em grupo');
  }
  if (requirements.require_group_admin && context.isSenderAdmin === false) {
    reasons.push('este comando exige permissao de admin do grupo');
  }
  if (requirements.require_bot_owner && context.isSenderOwner === false) {
    reasons.push('este comando exige admin principal do bot');
  }
  if (requirements.require_nsfw_enabled && context.groupNsfwEnabled === false) {
    reasons.push('NSFW precisa estar ativo no grupo');
  }

  return {
    allowed: reasons.length === 0,
    reasons,
  };
};

const levenshteinDistance = (left, right) => {
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (!a) return b.length;
  if (!b) return a.length;

  const matrix = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) matrix[0][j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
    }
  }

  return matrix[a.length][b.length];
};

const renderUsage = (method, commandPrefix = '/') => String(method || '').replaceAll('<prefix>', String(commandPrefix || '/'));

const toPositiveInt = (value, fallback, min = 1) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return parsed;
};

const clampText = (value, maxChars) => {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 20)).trimEnd()}\n\n[resposta truncada]`;
};

const normalizeLlmProvider = (value, fallback = 'gemini') => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (normalized === 'gemini') return 'gemini';
  if (normalized === 'openai') return 'openai';
  return fallback;
};

const looksLikeGeminiModel = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .includes('gemini');

const looksLikeOpenAiModel = (value) => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (!normalized) return false;
  return normalized.startsWith('gpt-') || normalized.startsWith('o1') || normalized.startsWith('o3') || normalized.startsWith('o4') || normalized.startsWith('text-');
};

const normalizeCacheSource = (value) => {
  const base = String(value || 'deterministic')
    .trim()
    .toLowerCase()
    .replace(/^db_/, '')
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  return (base || 'deterministic').slice(0, 32);
};

const buildCommandExplainCacheKey = (commandName) => `explicar comando ${normalizeText(commandName).replace(/^\/+/, '')}`;

const defaultGuidance = {
  faqSummary: ({ commandCount, faqCount, commandPrefix }) => ['🤖 FAQ atualizada.', `Comandos analisados: ${commandCount}.`, `Perguntas geradas: ${faqCount}.`, '', `Use ${commandPrefix}help <comando> para explicacao detalhada.`, `Use ${commandPrefix}ask <pergunta> para consulta livre.`].join('\n'),
  helpUsage: ({ commandPrefix }) => `Use ${commandPrefix}help <comando>.`,
  askUsage: ({ commandPrefix }) => `Use ${commandPrefix}ask <pergunta>.`,
  unknownCommand: ({ rawCommand, suggestions, commandPrefix }) => [`❓ O comando *${rawCommand}* nao foi encontrado.`, suggestions ? `Talvez voce quis usar: ${suggestions}.` : '', `Use ${commandPrefix}help <comando> ou ${commandPrefix}faq para listar opcoes.`].filter(Boolean).join('\n'),
  missingCommandText: ({ commandPrefix }) => `Nao encontrei esse comando. Use ${commandPrefix}faq para listar opcoes.`,
  questionFallback: ({ commandPrefix, detectedCommand, suggestions }) => {
    if (detectedCommand) {
      return `Posso te ajudar com ${commandPrefix}${detectedCommand}. Tente: ${commandPrefix}help ${detectedCommand}`;
    }
    return ['Nao encontrei resposta pronta para essa pergunta no FAQ.', `Tente ${commandPrefix}ask "como usar <comando>" ou ${commandPrefix}help <comando>.`, suggestions ? `Sugestoes rapidas: ${suggestions}.` : ''].filter(Boolean).join('\n');
  },
};

export const createModuleAiHelpService = ({ moduleKey, moduleLabel = 'modulo', envPrefix = 'MODULE_AI_HELP', getModuleConfig, resolveCommandName, getCommandEntry, listEnabledCommands, agentMdPath, logger = defaultLogger, guidance = {} }) => {
  if (typeof getModuleConfig !== 'function') {
    throw new Error('createModuleAiHelpService: getModuleConfig e obrigatorio');
  }
  if (typeof resolveCommandName !== 'function') {
    throw new Error('createModuleAiHelpService: resolveCommandName e obrigatorio');
  }
  if (typeof getCommandEntry !== 'function') {
    throw new Error('createModuleAiHelpService: getCommandEntry e obrigatorio');
  }
  if (typeof listEnabledCommands !== 'function') {
    throw new Error('createModuleAiHelpService: listEnabledCommands e obrigatorio');
  }

  const guidanceFns = {
    ...defaultGuidance,
    ...(guidance || {}),
  };

  const envValue = (name) => process.env[`${envPrefix}_${name}`];

  const getAiHelpConfig = () => {
    const moduleConfig = getModuleConfig();
    const aiHelp = moduleConfig?.ai_help && typeof moduleConfig.ai_help === 'object' ? moduleConfig.ai_help : {};
    const faq = aiHelp?.faq && typeof aiHelp.faq === 'object' ? aiHelp.faq : {};
    const llm = aiHelp?.llm && typeof aiHelp.llm === 'object' ? aiHelp.llm : {};

    const cachePathValue = String(faq.cache_file || '').trim();
    const cachePath = cachePathValue ? path.resolve(process.cwd(), cachePathValue) : path.join(process.cwd(), 'data', 'cache', `${moduleKey}-ai-faq-cache.json`);

    const provider = normalizeLlmProvider(envValue('PROVIDER') || llm.provider || process.env.AI_HELP_LLM_PROVIDER, process.env.GEMINI_API_KEY ? 'gemini' : 'openai');
    const defaultModelByProvider = provider === 'gemini' ? process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL : process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
    const rawModel = String(envValue('MODEL') || llm.model || defaultModelByProvider).trim() || defaultModelByProvider;
    const modelFromEnv = String(envValue('MODEL') || '').trim();
    const hasExplicitModelOverride = Boolean(modelFromEnv);
    let resolvedModel = rawModel;
    if (provider === 'gemini' && !hasExplicitModelOverride && !looksLikeGeminiModel(rawModel) && looksLikeOpenAiModel(rawModel)) {
      resolvedModel = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
    }
    if (provider === 'openai' && !hasExplicitModelOverride && looksLikeGeminiModel(rawModel)) {
      resolvedModel = process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
    }

    return {
      enabled: aiHelp.enabled !== false,
      faq: {
        intervalMs: Math.max(60_000, toPositiveInt(envValue('FAQ_INTERVAL_MS') || faq.interval_ms, DEFAULT_FAQ_INTERVAL_MS, 60_000)),
        autoGenerateOnStart:
          String(envValue('SCHEDULER_ENABLED') || (faq.auto_generate_on_start === false ? 'false' : 'true'))
            .trim()
            .toLowerCase() !== 'false',
        cachePath,
      },
      llm: {
        enabled:
          llm.enabled !== false &&
          String(envValue('ENABLE_LLM') || 'true')
            .trim()
            .toLowerCase() !== 'false',
        provider,
        model: resolvedModel,
        maxResponseChars: Math.max(400, toPositiveInt(envValue('MAX_RESPONSE_CHARS') || llm.max_response_chars, DEFAULT_MAX_RESPONSE_CHARS, 400)),
        maxAgentContextChars: Math.max(2_000, toPositiveInt(envValue('MAX_AGENT_CONTEXT_CHARS') || llm.max_agent_context_chars, DEFAULT_MAX_AGENT_CONTEXT_CHARS, 2_000)),
        timeoutMs: Math.max(1_000, toPositiveInt(envValue('TIMEOUT_MS') || llm.timeout_ms, DEFAULT_TIMEOUT_MS, 1_000)),
      },
    };
  };

  const FAQ_CACHE_VERSION = 1;
  let schedulerStarted = false;
  let schedulerHandle = null;
  let cacheWriteChain = Promise.resolve();
  let faqGenerationPromise = null;
  let cachedOpenAIClient = null;
  let cachedGeminiService = null;

  const createEmptyCache = () => ({
    version: FAQ_CACHE_VERSION,
    updatedAt: null,
    generatedAt: null,
    faqByCommand: {},
    questionCache: {},
    metrics: {
      faq_hits: 0,
      question_hits: 0,
      misses: 0,
      llm_calls: 0,
      llm_errors: 0,
      generated_count: 0,
      unknown_suggestions: 0,
      last_generated_at: null,
    },
  });

  const ensureCacheDir = async () => {
    const { faq } = getAiHelpConfig();
    await fs.mkdir(path.dirname(faq.cachePath), { recursive: true });
  };

  const withCacheWrite = async (writer) => {
    cacheWriteChain = cacheWriteChain
      .then(async () => {
        await ensureCacheDir();
        return writer();
      })
      .catch((error) => {
        logger.warn(`${moduleKey}_ai_help: falha ao persistir cache.`, {
          error: error?.message,
        });
      });

    return cacheWriteChain;
  };

  const readCache = async () => {
    const { faq } = getAiHelpConfig();
    try {
      const raw = await fs.readFile(faq.cachePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return createEmptyCache();
      return {
        ...createEmptyCache(),
        ...parsed,
        faqByCommand: parsed.faqByCommand && typeof parsed.faqByCommand === 'object' ? parsed.faqByCommand : {},
        questionCache: parsed.questionCache && typeof parsed.questionCache === 'object' ? parsed.questionCache : {},
        metrics: parsed.metrics && typeof parsed.metrics === 'object' ? { ...createEmptyCache().metrics, ...parsed.metrics } : createEmptyCache().metrics,
      };
    } catch {
      return createEmptyCache();
    }
  };

  const writeCache = async (cache) => {
    const { faq } = getAiHelpConfig();
    await withCacheWrite(async () => {
      await fs.writeFile(faq.cachePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
    });
  };

  const withFaqGenerationLock = async (generator) => {
    if (faqGenerationPromise) return faqGenerationPromise;
    faqGenerationPromise = generator()
      .catch((error) => {
        logger.error(`${moduleKey}_ai_help: erro ao gerar FAQ.`, {
          error: error?.message,
        });
        return {
          ok: false,
          error: error?.message || 'faq_generation_failed',
        };
      })
      .finally(() => {
        faqGenerationPromise = null;
      });
    return faqGenerationPromise;
  };

  const buildCommandFaqItems = (entry, commandPrefix = '/') => {
    const commandToken = `${commandPrefix}${entry.name}`;
    const usageLines = readEntryUsage(entry).map((method) => renderUsage(method, commandPrefix));
    const firstUsage = usageLines[0] || commandToken;
    const whereLabel = formatWhereLabel(readEntryContexts(entry));
    const permissionLabel = formatPermissionLabel(readEntryPermission(entry));

    return [
      {
        question: `Como usar ${commandToken}?`,
        answer: [`Use ${commandToken} desta forma:`, ...usageLines.map((line) => `- ${line}`), '', `Permissao: ${permissionLabel}.`, `Local de uso: ${whereLabel}.`, 'A IA apenas orienta; nao executa comando.'].join('\n'),
        source: 'deterministic',
      },
      {
        question: `Quem pode usar ${commandToken}?`,
        answer: [`${commandToken} exige: ${permissionLabel}.`, `Onde pode ser usado: ${whereLabel}.`, `Uso base: ${firstUsage}.`].join('\n'),
        source: 'deterministic',
      },
      {
        question: `Onde posso usar ${commandToken}?`,
        answer: [`Local permitido para ${commandToken}: ${whereLabel}.`, `Permissao necessaria: ${permissionLabel}.`].join('\n'),
        source: 'deterministic',
      },
    ];
  };

  const buildDeterministicCommandExplanation = ({ entry, commandPrefix = '/', context = {}, includeSecurity = true }) => {
    const { llm } = getAiHelpConfig();
    const commandToken = `${commandPrefix}${entry.name}`;
    const usage = readEntryUsage(entry).map((method) => renderUsage(method, commandPrefix));
    const preconditions = formatPreConditions(readEntryRequirements(entry));
    const gate = evaluatePreConditions(entry, context);
    const whereLabel = formatWhereLabel(readEntryContexts(entry));
    const permissionLabel = formatPermissionLabel(readEntryPermission(entry));

    const lines = [`📘 *Comando:* ${commandToken}`, `📝 ${readEntryDescription(entry) || 'Sem descricao cadastrada.'}`, '', `👤 *Quem pode usar:* ${permissionLabel}`, `📍 *Onde pode usar:* ${whereLabel}`, `⏱️ *Limite:* ${readEntryUsageLimit(entry) || 'nao informado'}`, '', '*Como usar:*', ...(usage.length ? usage.map((line) => `- ${line}`) : ['- Uso nao configurado no JSON.']), '', '*Pre-condicoes:*', ...preconditions];

    if (!gate.allowed) {
      lines.push('');
      lines.push('⚠️ *Contexto atual:* voce nao atende todas as pre-condicoes.');
      lines.push(...gate.reasons.map((reason) => `- ${reason}`));
    }

    if (includeSecurity) {
      lines.push('');
      lines.push('🔒 A IA apenas orienta. Nenhuma acao administrativa foi executada automaticamente.');
    }

    return clampText(lines.join('\n'), llm.maxResponseChars);
  };

  const readAgentExcerpt = async () => {
    const { llm } = getAiHelpConfig();
    const explicitExcerpt = clampText(process.env[`${envPrefix}_AGENT_EXCERPT`], llm.maxAgentContextChars);
    if (explicitExcerpt) return explicitExcerpt;
    if (!agentMdPath) return '';

    const normalizedAgentPath = String(agentMdPath).trim();
    if (!normalizedAgentPath) return '';
    const safeAgentName = path.basename(normalizedAgentPath);
    return clampText(`Considere as orientacoes locais do arquivo ${safeAgentName}.`, llm.maxAgentContextChars);
  };

  const summarizeConfigForPrompt = () => {
    const entries = listEnabledCommands();
    return entries
      .map((entry) => {
        const methods = readEntryUsage(entry).slice(0, 2).join(' | ');
        return `- ${entry.name} | permissao=${readEntryPermission(entry) || 'n/a'} | local=${formatWhereLabel(readEntryContexts(entry))} | uso=${methods}`;
      })
      .join('\n');
  };

  const isGeminiReady = () => Boolean(String(process.env.GEMINI_API_KEY || '').trim());
  const isOpenAIReady = () => Boolean(String(process.env.OPENAI_API_KEY || '').trim());
  const isProviderReady = (provider) => (provider === 'gemini' ? isGeminiReady() : isOpenAIReady());

  const canUseLLM = () => {
    const config = getAiHelpConfig();
    return config.enabled && config.llm.enabled && (isGeminiReady() || isOpenAIReady());
  };

  const getGeminiService = () => {
    if (!isGeminiReady()) return null;
    const config = getAiHelpConfig();
    if (!cachedGeminiService) {
      cachedGeminiService = createGeminiTextService({
        apiKey: process.env.GEMINI_API_KEY,
        defaultModel: config.llm.model || process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
        timeoutMs: config.llm.timeoutMs,
      });
    }
    return cachedGeminiService;
  };

  const getOpenAIClient = () => {
    if (!isOpenAIReady()) return null;
    const config = getAiHelpConfig();
    if (!cachedOpenAIClient) {
      cachedOpenAIClient = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        timeout: config.llm.timeoutMs,
        maxRetries: 0,
      });
    }
    return cachedOpenAIClient;
  };

  const callGeminiLLM = async ({ instructions, userPrompt, model }) => {
    const service = getGeminiService();
    if (!service) return null;

    const response = await service.generateText({
      instructions,
      userPrompt,
      model,
    });

    const text = String(response?.text || '').trim();
    if (!text) return null;
    return {
      provider: 'gemini',
      model: String(response?.model || model || '').trim() || model,
      text,
    };
  };

  const callOpenAiLLM = async ({ instructions, userPrompt, model }) => {
    const client = getOpenAIClient();
    if (!client) return null;

    const response = await client.responses.create({
      model,
      instructions,
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: userPrompt }],
        },
      ],
    });

    const text = String(response?.output_text || '').trim();
    if (!text) return null;
    return {
      provider: 'openai',
      model,
      text,
    };
  };

  const resolveLlmCallOrder = (provider = 'gemini') => {
    const primary = normalizeLlmProvider(provider, 'gemini');
    const fallback = primary === 'gemini' ? 'openai' : 'gemini';
    return [primary, fallback];
  };

  const askLLM = async ({ mode, question, commandName, commandPrefix = '/', context = {}, deterministicDraft }) => {
    const config = getAiHelpConfig();
    if (!canUseLLM()) return null;

    const agentExcerpt = await readAgentExcerpt();
    const configSummary = summarizeConfigForPrompt();
    const contextSummary = [`is_group_message=${Boolean(context.isGroupMessage)}`, `is_sender_admin=${Boolean(context.isSenderAdmin)}`, `is_sender_owner=${Boolean(context.isSenderOwner)}`, `command_prefix=${commandPrefix}`].join(' | ');

    const instructions = [`Voce e um assistente de ajuda para comandos do modulo ${moduleLabel}.`, 'Responda em PT-BR, de forma objetiva e acionavel.', 'Nunca execute acao; apenas explique.', 'Sempre informe quem pode usar e onde pode usar o comando.', 'Se houver restricao de pre-condicao, destaque no texto.', 'Nao invente comandos que nao estao no contexto.'].join(' ');

    const userPrompt = [`Modo: ${mode}`, commandName ? `Comando alvo: ${commandName}` : '', question ? `Pergunta: ${question}` : '', `Contexto: ${contextSummary}`, '', 'Rascunho deterministico:', deterministicDraft || '(vazio)', '', 'Resumo de comandos:', configSummary, '', 'Trecho do AGENT.md:', agentExcerpt].filter(Boolean).join('\n');

    const providerOrder = resolveLlmCallOrder(config.llm.provider);
    for (const provider of providerOrder) {
      if (!isProviderReady(provider)) continue;

      try {
        const result =
          provider === 'gemini'
            ? await callGeminiLLM({
                instructions,
                userPrompt,
                model: config.llm.model,
              })
            : await callOpenAiLLM({
                instructions,
                userPrompt,
                model: config.llm.model,
              });

        if (!result?.text) continue;
        return {
          provider,
          model: result.model,
          text: clampText(result.text, config.llm.maxResponseChars),
        };
      } catch (error) {
        logger.warn(`${moduleKey}_ai_help: falha no LLM.`, {
          mode,
          provider,
          commandName,
          error: error?.message,
        });
      }
    }

    return null;
  };

  const incrementCacheMetric = async (metricKey) => {
    const cache = await readCache();
    cache.metrics = {
      ...cache.metrics,
      [metricKey]: Number(cache.metrics?.[metricKey] || 0) + 1,
    };
    cache.updatedAt = new Date().toISOString();
    await writeCache(cache);
  };

  const saveQuestionCacheEntry = async ({ question, answer, source = 'deterministic', command = null, scope = CACHE_SCOPE_QUESTION, modelName = null, metadata = null, persistDb = true }) => {
    const config = getAiHelpConfig();
    const key = normalizeText(question);
    if (!key) return;
    const safeScope = scope === CACHE_SCOPE_COMMAND_EXPLAIN ? CACHE_SCOPE_COMMAND_EXPLAIN : CACHE_SCOPE_QUESTION;
    const normalizedSource = normalizeCacheSource(source);
    const normalizedAnswer = clampText(answer, config.llm.maxResponseChars);
    if (!normalizedAnswer) return;
    const now = new Date().toISOString();

    const cache = await readCache();
    cache.questionCache[key] = {
      question: String(question || '').trim(),
      answer: normalizedAnswer,
      source: normalizedSource,
      command,
      scope: safeScope,
      createdAt: now,
    };
    cache.updatedAt = now;
    await writeCache(cache);

    if (!persistDb) return;

    await upsertAiHelpCachedResponse({
      moduleKey,
      scope: safeScope,
      question: String(question || '').trim() || key,
      normalizedQuestion: key,
      answer: normalizedAnswer,
      source: normalizedSource,
      commandName: command,
      modelName,
      metadata,
    });
  };

  const flattenFaq = (faqByCommand = {}) => {
    const rows = [];
    for (const [commandName, list] of Object.entries(faqByCommand || {})) {
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        rows.push({ commandName, ...(item || {}) });
      }
    }
    return rows;
  };

  const detectCommandInText = (value) => {
    const normalized = normalizeText(value);
    if (!normalized) return null;

    const tokens = normalized.split(/\s+/).filter(Boolean);
    for (const token of tokens) {
      const raw = token.replace(/^\/+/, '');
      const canonical = resolveCommandName(raw);
      if (canonical) return canonical;
    }

    for (const token of tokens) {
      const canonical = resolveCommandName(token);
      if (canonical) return canonical;
    }

    return null;
  };

  const lookupQuestionCacheEntry = async ({ question, scope = CACHE_SCOPE_QUESTION } = {}) => {
    const normalizedQuestion = normalizeText(question);
    if (!normalizedQuestion) {
      return { answer: null, source: 'none', commandName: null };
    }

    const safeScope = scope === CACHE_SCOPE_COMMAND_EXPLAIN ? CACHE_SCOPE_COMMAND_EXPLAIN : CACHE_SCOPE_QUESTION;

    const dbCached = await getAiHelpCachedResponse({
      moduleKey,
      scope: safeScope,
      question,
      normalizedQuestion,
      updateUsage: true,
    });

    if (dbCached?.answer_text) {
      return {
        answer: dbCached.answer_text,
        source: safeScope === CACHE_SCOPE_COMMAND_EXPLAIN ? 'db_command_cache' : 'db_question_cache',
        commandName: dbCached.command_name || null,
      };
    }

    const cache = await readCache();
    const cachedQuestion = cache.questionCache?.[normalizedQuestion];
    if (cachedQuestion?.answer) {
      return {
        answer: cachedQuestion.answer,
        source: 'question_cache',
        commandName: cachedQuestion.command || null,
      };
    }

    return { answer: null, source: 'none', commandName: null };
  };

  const lookupFaqAnswer = async (question) => {
    const normalizedQuestion = normalizeText(question);
    if (!normalizedQuestion) return { answer: null, source: 'none', commandName: null };

    const cachedQuestion = await lookupQuestionCacheEntry({
      question,
      scope: CACHE_SCOPE_QUESTION,
    });
    if (cachedQuestion.answer) return cachedQuestion;

    const cache = await readCache();
    const allFaq = flattenFaq(cache.faqByCommand || {});
    const exact = allFaq.find((item) => normalizeText(item.question) === normalizedQuestion);
    if (exact?.answer) {
      return {
        answer: exact.answer,
        source: 'faq_exact',
        commandName: exact.commandName || null,
      };
    }

    const fuzzy = allFaq.find((item) => {
      const itemQuestion = normalizeText(item.question);
      if (!itemQuestion) return false;
      return itemQuestion.includes(normalizedQuestion) || normalizedQuestion.includes(itemQuestion);
    });

    if (fuzzy?.answer) {
      return {
        answer: fuzzy.answer,
        source: 'faq_fuzzy',
        commandName: fuzzy.commandName || null,
      };
    }

    return { answer: null, source: 'none', commandName: null };
  };

  const generateFaq = async ({ commandPrefix = '/', force = false, reason = 'manual' } = {}) =>
    withFaqGenerationLock(async () => {
      const config = getAiHelpConfig();
      if (!config.enabled) {
        return {
          ok: false,
          disabled: true,
          commandCount: 0,
          faqCount: 0,
          text: 'Ajuda IA desativada na configuracao do modulo.',
        };
      }

      const cache = await readCache();
      const now = new Date().toISOString();

      if (!force && cache.generatedAt) {
        const ageMs = Date.now() - new Date(cache.generatedAt).getTime();
        if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < config.faq.intervalMs) {
          const commandCount = Object.keys(cache.faqByCommand || {}).length;
          const faqCount = Object.values(cache.faqByCommand || {}).reduce((acc, list) => acc + (Array.isArray(list) ? list.length : 0), 0);
          return {
            ok: true,
            commandCount,
            faqCount,
            cached: true,
            text: guidanceFns.faqSummary({ commandCount, faqCount, commandPrefix }),
          };
        }
      }

      const entries = listEnabledCommands();
      const faqByCommand = {};
      let faqCount = 0;

      for (const entry of entries) {
        const canonicalName = String(entry?.name || '')
          .trim()
          .toLowerCase();
        if (!canonicalName) continue;
        const items = buildCommandFaqItems(entry, commandPrefix).map((item) => ({
          ...item,
          createdAt: now,
        }));
        faqByCommand[canonicalName] = items;
        faqCount += items.length;
      }

      const updated = {
        ...cache,
        version: FAQ_CACHE_VERSION,
        faqByCommand,
        updatedAt: now,
        generatedAt: now,
        metrics: {
          ...cache.metrics,
          generated_count: Number(cache.metrics?.generated_count || 0) + 1,
          last_generated_at: now,
        },
      };

      await writeCache(updated);

      return {
        ok: true,
        commandCount: entries.length,
        faqCount,
        cached: false,
        reason,
        text: guidanceFns.faqSummary({ commandCount: entries.length, faqCount, commandPrefix }),
      };
    });

  const explainCommand = async (command, context = {}) => {
    await generateFaq({ commandPrefix: context.commandPrefix || '/', reason: 'warmup' });

    const canonical = resolveCommandName(command);
    if (!canonical) {
      const suggestion = buildUnknownCommandSuggestion(command, {
        commandPrefix: context.commandPrefix || '/',
      });
      await incrementCacheMetric('misses');
      return {
        ok: false,
        commandName: null,
        source: 'none',
        text:
          suggestion ||
          guidanceFns.missingCommandText({
            commandPrefix: context.commandPrefix || '/',
          }),
      };
    }

    const entry = getCommandEntry(canonical);
    if (!entry || entry.enabled === false) {
      await incrementCacheMetric('misses');
      return {
        ok: false,
        commandName: canonical,
        source: 'none',
        text: `O comando ${context.commandPrefix || '/'}${canonical} esta desativado no momento.`,
      };
    }

    const explainCacheKey = buildCommandExplainCacheKey(canonical);
    const cachedExplanation = await lookupQuestionCacheEntry({
      question: explainCacheKey,
      scope: CACHE_SCOPE_COMMAND_EXPLAIN,
    });
    if (cachedExplanation.answer) {
      await incrementCacheMetric('question_hits');
      return {
        ok: true,
        commandName: canonical,
        source: cachedExplanation.source,
        text: clampText(cachedExplanation.answer, getAiHelpConfig().llm.maxResponseChars),
      };
    }

    const deterministic = buildDeterministicCommandExplanation({
      entry,
      commandPrefix: context.commandPrefix || '/',
      context,
    });

    const llmAnswer = await askLLM({
      mode: 'explain_command',
      commandName: canonical,
      commandPrefix: context.commandPrefix || '/',
      context,
      deterministicDraft: deterministic,
    });

    if (llmAnswer?.text) {
      const llmSource = `llm_${llmAnswer.provider || 'unknown'}`;
      await incrementCacheMetric('llm_calls');
      await saveQuestionCacheEntry({
        question: explainCacheKey,
        answer: llmAnswer.text,
        source: llmSource,
        command: canonical,
        scope: CACHE_SCOPE_COMMAND_EXPLAIN,
        modelName: llmAnswer.model || getAiHelpConfig().llm.model,
        metadata: { mode: 'explain_command', module: moduleKey, provider: llmAnswer.provider || 'unknown' },
      });
      return {
        ok: true,
        commandName: canonical,
        source: llmSource,
        text: llmAnswer.text,
      };
    }

    if (canUseLLM()) {
      await incrementCacheMetric('llm_errors');
    }

    await saveQuestionCacheEntry({
      question: explainCacheKey,
      answer: deterministic,
      source: 'deterministic',
      command: canonical,
      scope: CACHE_SCOPE_COMMAND_EXPLAIN,
      metadata: { mode: 'explain_command', module: moduleKey },
    });

    return {
      ok: true,
      commandName: canonical,
      source: 'deterministic',
      text: deterministic,
    };
  };

  const answerQuestion = async (question, context = {}) => {
    const rawQuestion = String(question || '').trim();
    if (!rawQuestion) {
      return {
        ok: false,
        source: 'none',
        text: guidanceFns.askUsage({ commandPrefix: context.commandPrefix || '/' }),
        commandName: null,
      };
    }

    await generateFaq({ commandPrefix: context.commandPrefix || '/', reason: 'warmup' });

    const explicitCommand = detectCommandInText(rawQuestion);
    if (explicitCommand) {
      const explanation = await explainCommand(explicitCommand, context);
      if (explanation?.ok) {
        await incrementCacheMetric('question_hits');
        await saveQuestionCacheEntry({
          question: rawQuestion,
          answer: explanation.text,
          source: explanation.source,
          command: explanation.commandName,
        });
        return {
          ok: true,
          source: explanation.source,
          commandName: explanation.commandName,
          text: explanation.text,
        };
      }
    }

    const faqLookup = await lookupFaqAnswer(rawQuestion);
    if (faqLookup.answer) {
      const isQuestionCacheSource = ['question_cache', 'db_question_cache', 'db_command_cache'].includes(faqLookup.source);
      await incrementCacheMetric(isQuestionCacheSource ? 'question_hits' : 'faq_hits');
      return {
        ok: true,
        source: faqLookup.source,
        commandName: faqLookup.commandName,
        text: clampText(faqLookup.answer, getAiHelpConfig().llm.maxResponseChars),
      };
    }

    const suggestions = listEnabledCommands()
      .slice(0, 6)
      .map((entry) => `${context.commandPrefix || '/'}${entry.name}`)
      .join(', ');

    const deterministicFallback = guidanceFns.questionFallback({
      question: rawQuestion,
      commandPrefix: context.commandPrefix || '/',
      detectedCommand: explicitCommand,
      suggestions,
    });

    const llmAnswer = await askLLM({
      mode: 'answer_question',
      question: rawQuestion,
      commandName: explicitCommand,
      commandPrefix: context.commandPrefix || '/',
      context,
      deterministicDraft: deterministicFallback,
    });

    if (llmAnswer?.text) {
      const llmSource = `llm_${llmAnswer.provider || 'unknown'}`;
      await incrementCacheMetric('llm_calls');
      await saveQuestionCacheEntry({
        question: rawQuestion,
        answer: llmAnswer.text,
        source: llmSource,
        command: explicitCommand,
        modelName: llmAnswer.model || getAiHelpConfig().llm.model,
        metadata: { mode: 'answer_question', module: moduleKey, provider: llmAnswer.provider || 'unknown' },
      });
      return {
        ok: true,
        source: llmSource,
        commandName: explicitCommand,
        text: llmAnswer.text,
      };
    }

    if (canUseLLM()) {
      await incrementCacheMetric('llm_errors');
    }

    await incrementCacheMetric('misses');
    await saveQuestionCacheEntry({
      question: rawQuestion,
      answer: deterministicFallback,
      source: 'deterministic',
      command: explicitCommand,
      metadata: { mode: 'answer_question', module: moduleKey },
    });

    return {
      ok: true,
      source: 'deterministic',
      commandName: explicitCommand,
      text: deterministicFallback,
    };
  };

  const buildUnknownCommandSuggestion = (rawCommand, { commandPrefix = '/' } = {}) => {
    const command = normalizeText(rawCommand).replace(/^\/+/, '');
    if (!command) return null;

    const entries = listEnabledCommands();
    const tokens = [];

    for (const entry of entries) {
      const canonical = String(entry.name || '')
        .trim()
        .toLowerCase();
      if (!canonical) continue;
      tokens.push({ token: canonical, canonical });

      const aliases = Array.isArray(entry.aliases) ? entry.aliases : [];
      for (const alias of aliases) {
        const normalizedAlias = normalizeText(alias);
        if (!normalizedAlias) continue;
        tokens.push({ token: normalizedAlias, canonical });
      }
    }

    const ranked = tokens
      .map((item) => ({
        ...item,
        distance: levenshteinDistance(command, item.token),
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 3);

    if (!ranked.length) return null;

    const bestDistance = ranked[0].distance;
    const tolerance = Math.max(2, Math.floor(command.length * 0.45));
    if (bestDistance > tolerance) return null;

    const uniqueCanonical = [];
    for (const item of ranked) {
      if (!uniqueCanonical.includes(item.canonical)) uniqueCanonical.push(item.canonical);
    }

    if (!uniqueCanonical.length) return null;

    const suggestions = uniqueCanonical.map((value) => `${commandPrefix}${value}`).join(', ');
    return guidanceFns.unknownCommand({
      rawCommand,
      suggestions,
      commandPrefix,
    });
  };

  const startScheduler = () => {
    if (schedulerStarted) return;
    schedulerStarted = true;

    const config = getAiHelpConfig();
    if (!config.enabled || !config.faq.autoGenerateOnStart) return;

    const runScheduledGeneration = async () => {
      try {
        await generateFaq({ reason: 'scheduler', force: true });
      } catch (error) {
        logger.warn(`${moduleKey}_ai_help: scheduler falhou ao gerar FAQ.`, {
          error: error?.message,
        });
      }
    };

    runScheduledGeneration();
    schedulerHandle = setInterval(runScheduledGeneration, config.faq.intervalMs);
    if (typeof schedulerHandle?.unref === 'function') {
      schedulerHandle.unref();
    }
  };

  const stopSchedulerForTests = () => {
    if (schedulerHandle) {
      clearInterval(schedulerHandle);
      schedulerHandle = null;
    }
    schedulerStarted = false;
  };

  return {
    gerarFaqAutomatica: generateFaq,
    explicarComando: explainCommand,
    responderPergunta: answerQuestion,
    buildUnknownCommandSuggestion,
    startScheduler,
    stopSchedulerForTests,
  };
};
