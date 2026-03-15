/* eslint-disable no-useless-escape */

/**
 * Módulo de acesso ao MySQL com:
 * - Pool de conexões (mysql2/promise)
 * - Monitoramento de queries (latência, slow queries, erros, top queries)
 * - Log estruturado em arquivo com rotação
 * - Integração opcional com métricas (Prometheus / observability)
 *
 * Objetivo:
 * centralizar todas as operações de banco e entregar:
 * ✅ execução segura (sanitize params)
 * ✅ diagnóstico (stats + logs)
 * ✅ métricas (quando habilitadas)
 */

import 'dotenv/config';
import mysql from 'mysql2/promise';
import fs from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { promises as fsPromises } from 'node:fs';
import logger from '#logger';
import { isMetricsEnabled, recordDbQuery, recordDbWrite, recordError, setDbInFlight } from '../app/observability/metrics.js';

const { NODE_ENV } = process.env;
const { DB_HOST, DB_USER, DB_PASSWORD, DB_NAME, DB_POOL_LIMIT = 10 } = process.env;

/**
 * Lista de variáveis de ambiente obrigatórias para inicializar o banco.
 * Caso faltem, o processo encerra para evitar rodar o app em estado inválido.
 * @type {string[]}
 */
const requiredEnvVars = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
const missingEnvVars = requiredEnvVars.filter((varName) => !process.env[varName]);

if (missingEnvVars.length > 0) {
  logger.error(`Variáveis de ambiente de banco de dados necessárias não encontradas: ${missingEnvVars.join(', ')}`);
  process.exit(1);
}

/**
 * Ambiente atual (production / development etc).
 * Usado para definir defaults e nome do banco com sufixo _dev/_prod.
 * @type {string}
 */
const environment = NODE_ENV || 'development';

/**
 * Resolve o nome do banco baseado no ambiente.
 * - Em produção, adiciona sufixo `_prod`
 * - Em desenvolvimento, adiciona sufixo `_dev`
 * - Se já tiver _dev ou _prod, mantém como está
 *
 * @param {string} baseName Nome base do banco (DB_NAME)
 * @param {string} env Ambiente (production/development)
 * @returns {string} Nome final do banco
 */
const resolveDbName = (baseName, env) => {
  const suffix = env === 'production' ? 'prod' : 'dev';
  if (baseName.endsWith('_dev') || baseName.endsWith('_prod')) {
    return baseName;
  }
  return `${baseName}_${suffix}`;
};

const dbName = resolveDbName(DB_NAME, environment);

/**
 * Configuração do banco baseada nas variáveis de ambiente.
 * Esse objeto é exportado para ser utilizado por outros módulos (ex: init/migrations).
 *
 * @type {{host: string, user: string, password: string, database: string, poolLimit: number}}
 */
export const dbConfig = {
  host: DB_HOST,
  user: DB_USER,
  password: DB_PASSWORD,
  database: dbName,
  poolLimit: Number(DB_POOL_LIMIT),
};

logger.info(`Configuração de banco de dados carregada para o ambiente: ${environment}`);

/**
 * Mapa de tabelas suportadas no sistema (allow-list).
 * Ajuda a reduzir risco de SQL injection em funções que aceitam "tableName".
 *
 * @type {{MESSAGES: string, CHATS: string, GROUPS_METADATA: string, GROUP_CONFIGS: string, LID_MAP: string}}
 */
export const TABLES = {
  MESSAGES: 'messages',
  AI_HELP_RESPONSE_CACHE: 'ai_help_response_cache',
  AI_LEARNING_EVENTS: 'ai_learning_events',
  AI_LEARNED_PATTERNS: 'ai_learned_patterns',
  AI_LEARNED_KEYWORDS: 'ai_learned_keywords',
  AI_QUESTION_EMBEDDINGS: 'ai_question_embeddings',
  AI_COMMAND_CONFIG_ENRICHMENT_CURSOR: 'ai_command_config_enrichment_cursor',
  AI_COMMAND_CONFIG_ENRICHMENT_SUGGESTION: 'ai_command_config_enrichment_suggestion',
  AI_COMMAND_CONFIG_ENRICHMENT_STATE: 'ai_command_config_enrichment_state',
  MESSAGE_ANALYSIS_EVENT: 'message_analysis_event',
  BAILEYS_EVENT_JOURNAL: 'baileys_event_journal',
  BAILEYS_AUTH_STATE: 'baileys_auth_state',
  CHATS: 'chats',
  GROUPS_METADATA: 'groups_metadata',
  GROUP_CONFIGS: 'group_configs',
  LID_MAP: 'lid_map',
  STICKER_PACK: 'sticker_pack',
  STICKER_ASSET: 'sticker_asset',
  STICKER_PACK_ITEM: 'sticker_pack_item',
  STICKER_PACK_WEB_UPLOAD: 'sticker_pack_web_upload',
  STICKER_ASSET_CLASSIFICATION: 'sticker_asset_classification',
  SEMANTIC_THEME_CLUSTER: 'semantic_theme_clusters',
  SEMANTIC_THEME_SUGGESTION_CACHE: 'semantic_theme_suggestion_cache',
  STICKER_PACK_ENGAGEMENT: 'sticker_pack_engagement',
  STICKER_PACK_INTERACTION_EVENT: 'sticker_pack_interaction_event',
  WEB_VISIT_EVENT: 'web_visit_event',
  STICKER_PACK_SCORE_SNAPSHOT: 'sticker_pack_score_snapshot',
  STICKER_ASSET_REPROCESS_QUEUE: 'sticker_asset_reprocess_queue',
  STICKER_WORKER_TASK_QUEUE: 'sticker_worker_task_queue',
  STICKER_WORKER_TASK_DLQ: 'sticker_worker_task_dlq',
  DOMAIN_EVENT_OUTBOX: 'domain_event_outbox',
  DOMAIN_EVENT_OUTBOX_DLQ: 'domain_event_outbox_dlq',
  EMAIL_OUTBOX: 'email_outbox',
  FEATURE_FLAG: 'feature_flag',
  STICKER_WEB_GOOGLE_USER: 'web_google_user',
  STICKER_WEB_GOOGLE_SESSION: 'web_google_session',
  STICKER_WEB_USER_PASSWORD: 'web_user_password',
  STICKER_WEB_USER_PASSWORD_LOGIN_THROTTLE: 'web_user_password_login_throttle',
  STICKER_WEB_USER_PASSWORD_RECOVERY_CODE: 'web_user_password_recovery_code',
  STICKER_WEB_TERMS_ACCEPTANCE_EVENT: 'web_terms_acceptance_event',
  STICKER_WEB_ADMIN_BAN: 'web_admin_ban',
  STICKER_WEB_ADMIN_MODERATOR: 'web_admin_moderator',
  ADMIN_ACTION_AUDIT: 'admin_action_audit',
  RPG_PLAYER: 'rpg_player',
  RPG_PLAYER_POKEMON: 'rpg_player_pokemon',
  RPG_BATTLE_STATE: 'rpg_battle_state',
  RPG_PLAYER_INVENTORY: 'rpg_player_inventory',
  RPG_GROUP_BIOME: 'rpg_group_biome',
  RPG_PLAYER_MISSION_PROGRESS: 'rpg_player_mission_progress',
  RPG_PLAYER_POKEDEX: 'rpg_player_pokedex',
  RPG_PLAYER_TRAVEL: 'rpg_player_travel',
  RPG_RAID_STATE: 'rpg_raid_state',
  RPG_RAID_PARTICIPANT: 'rpg_raid_participant',
  RPG_PVP_CHALLENGE: 'rpg_pvp_challenge',
  RPG_PVP_QUEUE: 'rpg_pvp_queue',
  RPG_PVP_WEEKLY_STATS: 'rpg_pvp_weekly_stats',
  RPG_SOCIAL_LINK: 'rpg_social_link',
  RPG_TRADE_OFFER: 'rpg_trade_offer',
  RPG_GROUP_COOP_WEEKLY: 'rpg_group_coop_weekly',
  RPG_GROUP_COOP_MEMBER: 'rpg_group_coop_member',
  RPG_GROUP_EVENT_WEEKLY: 'rpg_group_event_weekly',
  RPG_GROUP_EVENT_MEMBER: 'rpg_group_event_member',
  RPG_KARMA_PROFILE: 'rpg_karma_profile',
  RPG_KARMA_VOTE_HISTORY: 'rpg_karma_vote_history',
  RPG_GROUP_ACTIVITY_DAILY: 'rpg_group_activity_daily',
  RPG_SOCIAL_XP_DAILY: 'rpg_social_xp_daily',
};

/**
 * Pool de conexões com o MySQL.
 * - waitForConnections: enfileira caso limite estoure
 * - connectionLimit: máximo de conexões simultâneas
 * - timezone 'Z': mantém timestamps em UTC
 * - utf8mb4: suporta emojis e caracteres especiais
 *
 * @type {import('mysql2/promise').Pool}
 */
export const pool = mysql.createPool({
  host: dbConfig.host,
  user: dbConfig.user,
  password: dbConfig.password,
  database: dbConfig.database,
  waitForConnections: true,
  connectionLimit: dbConfig.poolLimit,
  queueLimit: 0,
  timezone: 'Z',
  charset: 'utf8mb4',
});

/**
 * Converte strings de env para boolean de forma tolerante.
 * Aceita: 1/0, true/false, yes/no, y/n, on/off.
 *
 * @param {unknown} value Valor bruto vindo do process.env
 * @param {boolean} fallback Valor padrão se não for possível interpretar
 * @returns {boolean}
 */
const parseEnvBool = (value, fallback) => {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
};

/**
 * Converte strings de env para número com fallback.
 *
 * @param {unknown} value Valor bruto (env)
 * @param {number} fallback Valor padrão se parse falhar
 * @returns {number}
 */
const parseEnvNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * Flag que indica se o subsistema de métricas está ativo.
 * Quando ativo, o código registra métricas de:
 * - duração
 * - tipo da query
 * - tabela
 * - erro/slow
 * - in-flight
 *
 * @type {boolean}
 */
const METRICS_ACTIVE = isMetricsEnabled();

/**
 * Keys permitidas no objeto options de executeQuery().
 * Hoje só aceitamos traceId para correlacionar logs/requests.
 * @type {Set<string>}
 */
const EXECUTE_OPTIONS_KEYS = new Set(['traceId']);

/**
 * Valida se um objeto recebido é um "options" válido.
 * Isso é usado pra suportar assinatura antiga (options no 3º parâmetro).
 *
 * @param {unknown} value
 * @returns {value is {traceId?: string}}
 */
const isValidExecuteOptions = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (!keys.length) {
    return false;
  }
  return keys.every((key) => EXECUTE_OPTIONS_KEYS.has(key));
};

/**
 * Defaults de monitor:
 * - Em produção, default é desativado (evita overhead e risco de logs excessivos)
 * - Em dev/staging, default é ativado (ajuda debug)
 */
const DB_MONITOR_DEFAULT_ENABLED = environment !== 'production';

/**
 * Configurações do monitor via env.
 * - slowMs: a partir de quantos ms considerar slow query
 * - logEveryQuery: loga todas as queries (cuidado em produção)
 * - topN / sampleSize: ranking e amostra
 * - slowExplain: executa EXPLAIN para SELECT lentos (cuidado: pode custar)
 * - logPath/rotação
 * - snapshotEveryMs: escreve snapshots periódicos do estado
 */
const DB_MONITOR_ENABLED = parseEnvBool(process.env.DB_MONITOR_ENABLED, DB_MONITOR_DEFAULT_ENABLED);
const DB_SLOW_QUERY_MS = parseEnvNumber(process.env.DB_SLOW_QUERY_MS, 250);
const DB_LOG_EVERY_QUERY = parseEnvBool(process.env.DB_LOG_EVERY_QUERY, false);
const DB_STATS_TOP_N = Math.max(1, Math.floor(parseEnvNumber(process.env.DB_STATS_TOP_N, 10)));
const DB_STATS_SAMPLE_SIZE = Math.max(0, Math.floor(parseEnvNumber(process.env.DB_STATS_SAMPLE_SIZE, 2000)));
const DB_SLOW_EXPLAIN = parseEnvBool(process.env.DB_SLOW_EXPLAIN, false);
const rawMonitorLogPath = process.env.DB_MONITOR_LOG_PATH;
const DB_MONITOR_LOG_PATH = rawMonitorLogPath && rawMonitorLogPath.trim() !== '' ? path.resolve(rawMonitorLogPath) : path.resolve('logs', 'db-monitor.log');
const DB_MONITOR_LOG_ROTATE_MB = Math.max(0, parseEnvNumber(process.env.DB_MONITOR_LOG_ROTATE_MB, 20));
const DB_MONITOR_LOG_KEEP = Math.max(0, Math.floor(parseEnvNumber(process.env.DB_MONITOR_LOG_KEEP, 5)));
const DB_MONITOR_SNAPSHOT_EVERY_MS = Math.max(0, Math.floor(parseEnvNumber(process.env.DB_MONITOR_SNAPSHOT_EVERY_MS, 0)));

/**
 * Ativa warning sobre assinatura antiga de executeQuery() quando options vierem no 3º parâmetro.
 * Mantém retrocompatibilidade sem quebrar chamadas antigas.
 * @type {boolean}
 */
const DEPRECATION_WARN_EXECUTEQUERY_OPTIONS_IN_3RD_PARAM = true;

/**
 * Limites para logs:
 * - SQL_LOG_MAX: limita tamanho do SQL logado
 * - PARAMS_LOG_MAX: limita quantidade de params logados (e profundidade em arrays/objetos)
 */
const SQL_LOG_MAX = 800;
const PARAMS_LOG_MAX = 25;

const DB_MONITOR_LOG_ROTATE_BYTES = Math.max(0, DB_MONITOR_LOG_ROTATE_MB * 1024 * 1024);

/**
 * Proteção para Map de fingerprints não crescer indefinidamente.
 * MAX_FINGERPRINTS = max(sampleSize, topN*20, 500)
 */
const MAX_FINGERPRINTS = Math.max(DB_STATS_SAMPLE_SIZE, DB_STATS_TOP_N * 20, 500);

/**
 * Buckets do histograma de latência em milissegundos.
 * Usado para calcular percentis aproximados sem ordenar todas as amostras.
 */
const HISTOGRAM_BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

/**
 * Symbol usado como "tag" para marcar objetos (pool/connection) já wrapados.
 * Evita wrap duplicado e permite recuperar funções originais.
 */
const MONITOR_TAG = Symbol('dbMonitorWrapped');

/**
 * Objeto consolidado com o estado/configuração do monitor.
 * @type {{
 *   enabled: boolean,
 *   slowMs: number,
 *   logEveryQuery: boolean,
 *   topN: number,
 *   sampleSize: number,
 *   slowExplain: boolean,
 *   logPath: string,
 *   logRotateBytes: number,
 *   logKeep: number,
 *   snapshotEveryMs: number
 * }}
 */
const monitorConfig = {
  enabled: DB_MONITOR_ENABLED,
  slowMs: DB_SLOW_QUERY_MS,
  logEveryQuery: DB_LOG_EVERY_QUERY,
  topN: DB_STATS_TOP_N,
  sampleSize: DB_STATS_SAMPLE_SIZE,
  slowExplain: DB_SLOW_EXPLAIN,
  logPath: DB_MONITOR_LOG_PATH,
  logRotateBytes: DB_MONITOR_LOG_ROTATE_BYTES,
  logKeep: DB_MONITOR_LOG_KEEP,
  snapshotEveryMs: DB_MONITOR_SNAPSHOT_EVERY_MS,
};

/**
 * Regex usadas para mascarar dados sensíveis em logs.
 * - EMAIL_REGEX: mascara emails (ex: a***@dominio.com)
 * - JWT_REGEX: detecta tokens JWT
 * - TOKEN_LIKE_REGEX: tokens longos (api keys etc)
 */
const EMAIL_REGEX = /([A-Z0-9._%+-]+)@([A-Z0-9.-]+\.[A-Z]{2,})/i;
const JWT_REGEX = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+$/;
const TOKEN_LIKE_REGEX = /^[A-Za-z0-9-_=+.]{20,}$/;

/**
 * @typedef {Object} FingerprintEntry
 * @property {string} fingerprint Identificador da query (hash do SQL normalizado)
 * @property {string} normalizedSql SQL normalizado e truncado (para agrupamento)
 * @property {string|null} type Tipo da query (SELECT/INSERT/UPDATE/DELETE/DDL/OTHER)
 * @property {string|null} table Tabela extraída (quando possível)
 * @property {number} count Total de execuções
 * @property {number} errorCount Total de erros
 * @property {number} slowCount Total de slow queries
 * @property {number} totalMs Soma total em ms
 * @property {number} maxMs Maior duração observada
 * @property {number|null} minMs Menor duração observada
 * @property {number} lastMs Duração da última execução
 * @property {number} lastSeenAt Timestamp ms da última vez vista
 * @property {number|null} lastRowCount Último rowCount detectado (se aplicável)
 * @property {number|null} lastAffectedRows Último affectedRows detectado (se aplicável)
 */

/**
 * @typedef {Object} DbStats
 * @property {boolean} enabled Se o monitor está habilitado
 * @property {number} startedAt Timestamp ms da inicialização do monitor
 * @property {number} lastResetAt Timestamp ms do último reset
 * @property {{total:number, error:number, slow:number}} counters Contadores globais
 * @property {number} inFlight Queries em andamento (monitor)
 * @property {number} maxInFlight Pico de concorrência observado
 * @property {number} durationTotal Soma de todas durações (ms)
 * @property {number|null} durationMin Menor duração (ms)
 * @property {number|null} durationMax Maior duração (ms)
 * @property {number} durationCount Quantidade de medições
 * @property {number[]} samples Amostra circular de durações (ms)
 * @property {number} sampleCursor Cursor para sobrescrever amostra
 * @property {number[]} histogramBuckets Buckets do histograma
 * @property {number[]} histogramCounts Contadores do histograma (len = buckets+1)
 * @property {Map<string, FingerprintEntry>} fingerprints Métricas por query agrupada
 */

/** @type {DbStats} */
let dbStats = createEmptyStats();

/**
 * Contador de in-flight para métrica externa (observability).
 * Separado do dbStats (monitor) pois métricas podem estar ativas mesmo com monitor desligado.
 * @type {number}
 */
let dbInFlightMetric = 0;

/**
 * Cria o estado inicial de estatísticas do monitor.
 * Sempre que resetamos, os contadores e agregados voltam ao início.
 *
 * @returns {DbStats}
 */
function createEmptyStats() {
  return {
    enabled: monitorConfig.enabled,
    startedAt: Date.now(),
    lastResetAt: Date.now(),
    counters: {
      total: 0,
      error: 0,
      slow: 0,
    },
    inFlight: 0,
    maxInFlight: 0,
    durationTotal: 0,
    durationMin: null,
    durationMax: null,
    durationCount: 0,
    samples: [],
    sampleCursor: 0,
    histogramBuckets: HISTOGRAM_BUCKETS.slice(),
    histogramCounts: new Array(HISTOGRAM_BUCKETS.length + 1).fill(0),
    fingerprints: new Map(),
  };
}

/**
 * Cria um logger de monitoramento que grava JSON line (1 evento por linha) em arquivo.
 * Inclui:
 * - queue interna para não bloquear o fluxo (stream backpressure)
 * - criação automática do diretório
 * - rotação por tamanho (rotateBytes)
 * - retenção (keep)
 *
 * Se disabled, retorna um "noop logger" (log() não faz nada).
 *
 * @param {{enabled:boolean, logPath:string, rotateBytes:number, keep:number}} cfg
 * @returns {{log: (entry:any) => void}}
 */
function createDbMonitorLogger({ enabled, logPath, rotateBytes, keep }) {
  if (!enabled) {
    return {
      log: () => {},
    };
  }

  const dir = path.dirname(logPath);
  let stream = null;
  let streamSize = 0;
  let initializing = null;
  let processing = false;
  let rotating = false;
  const queue = [];

  /**
   * Remove arquivo ignorando ENOENT (não existe).
   * @param {string} target
   */
  const safeUnlink = async (target) => {
    try {
      await fsPromises.unlink(target);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  };

  /**
   * Renomeia arquivo ignorando ENOENT.
   * @param {string} from
   * @param {string} to
   */
  const safeRename = async (from, to) => {
    try {
      await fsPromises.rename(from, to);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  };

  /**
   * Garante que o stream de escrita está aberto.
   * Faz:
   * - mkdir do diretório
   * - stat para continuar contagem do tamanho
   * - abre stream em append
   */
  const ensureStream = async () => {
    if (stream) {
      return;
    }
    if (initializing) {
      await initializing;
      return;
    }

    initializing = (async () => {
      await fsPromises.mkdir(dir, { recursive: true });
      try {
        const stat = await fsPromises.stat(logPath);
        streamSize = stat.size;
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
        streamSize = 0;
      }
      stream = fs.createWriteStream(logPath, { flags: 'a' });
      stream.on('error', (error) => {
        logger.error('Erro no stream do monitor de banco.', {
          errorMessage: error.message,
        });
        stream = null;
      });
    })();

    try {
      await initializing;
    } finally {
      initializing = null;
    }
  };

  /**
   * Fecha stream atual.
   */
  const closeStream = async () => {
    if (!stream) {
      return;
    }
    const current = stream;
    stream = null;
    await new Promise((resolve) => current.end(resolve));
  };

  /**
   * Rotaciona logs:
   * - fecha stream
   * - renomeia `logPath` -> `logPath.1`, empurra as versões antigas
   * - remove `logPath.keep` se existir
   */
  const rotateLogs = async () => {
    if (rotating || rotateBytes <= 0) {
      return;
    }
    rotating = true;
    try {
      await closeStream();
      if (keep === 0) {
        await safeUnlink(logPath);
      } else {
        await safeUnlink(`${logPath}.${keep}`);
        for (let i = keep - 1; i >= 1; i -= 1) {
          await safeRename(`${logPath}.${i}`, `${logPath}.${i + 1}`);
        }
        await safeRename(logPath, `${logPath}.1`);
      }
    } catch (error) {
      logger.error('Erro ao rotacionar log do monitor de banco.', {
        errorMessage: error.message,
      });
    } finally {
      streamSize = 0;
      rotating = false;
    }
  };

  /**
   * Escreve uma linha no arquivo, respeitando backpressure do stream.
   * @param {string} line
   */
  const writeLine = async (line) => {
    await ensureStream();
    if (!stream) {
      return;
    }
    const payload = `${line}\n`;
    const canWrite = stream.write(payload);
    streamSize += Buffer.byteLength(payload);
    if (rotateBytes > 0 && streamSize >= rotateBytes) {
      await rotateLogs();
    }
    if (!canWrite && stream) {
      await once(stream, 'drain');
    }
  };

  /**
   * Processa fila de logs sequencialmente.
   * Evita concorrência e garante ordem razoável.
   */
  const processQueue = async () => {
    try {
      while (queue.length > 0) {
        const line = queue.shift();
        if (!line) {
          continue;
        }
        await writeLine(line);
      }
    } catch (error) {
      logger.error('Erro ao gravar log do monitor de banco.', {
        errorMessage: error.message,
      });
      queue.length = 0;
    } finally {
      processing = false;
      if (queue.length > 0) {
        processing = true;
        setImmediate(() => {
          processQueue().catch(() => {});
        });
      }
    }
  };

  /**
   * Enfileira um evento do monitor (JSON).
   * @param {any} entry
   */
  const enqueue = (entry) => {
    try {
      queue.push(JSON.stringify(entry));
    } catch (error) {
      queue.push(
        JSON.stringify({
          ts: new Date().toISOString(),
          event: 'logger_error',
          errorMessage: error.message,
        }),
      );
    }
    if (!processing) {
      processing = true;
      setImmediate(() => {
        processQueue().catch(() => {});
      });
    }
  };

  return {
    log: enqueue,
  };
}

const dbMonitorLogger = createDbMonitorLogger({
  enabled: monitorConfig.enabled,
  logPath: monitorConfig.logPath,
  rotateBytes: monitorConfig.logRotateBytes,
  keep: monitorConfig.logKeep,
});

/**
 * Reseta as estatísticas do monitor (não afeta o pool).
 * Útil para "zerar" o dashboard sem reiniciar o app.
 */
export function resetDbStats() {
  dbStats = createEmptyStats();
}

/**
 * Retorna um snapshot das estatísticas atuais.
 * Inclui:
 * - contadores totais/slow/erro
 * - concorrência (inFlight/maxInFlight)
 * - latências (avg/min/max/p50/p95/p99)
 * - histograma de buckets
 * - top queries (mais lentas e mais frequentes)
 *
 * @returns {object}
 */
export function getDbStats() {
  const now = Date.now();
  const sampleCount = dbStats.samples.length;
  const percentiles = calculatePercentiles();
  const histogram = {
    buckets: dbStats.histogramBuckets.slice(),
    counts: dbStats.histogramCounts.slice(),
  };
  const avgMs = dbStats.durationCount ? dbStats.durationTotal / dbStats.durationCount : null;

  const fingerprintStats = Array.from(dbStats.fingerprints.values()).map((entry) => ({
    fingerprint: entry.fingerprint,
    normalizedSql: entry.normalizedSql,
    type: entry.type,
    table: entry.table,
    count: entry.count,
    errorCount: entry.errorCount,
    slowCount: entry.slowCount,
    avgMs: Number((entry.totalMs / entry.count).toFixed(2)),
    maxMs: Number(entry.maxMs.toFixed(2)),
    lastMs: Number(entry.lastMs.toFixed(2)),
    lastSeenAt: new Date(entry.lastSeenAt).toISOString(),
  }));

  const topN = monitorConfig.topN;
  const topSlow = fingerprintStats
    .slice()
    .sort((a, b) => b.maxMs - a.maxMs)
    .slice(0, topN);

  const topFrequent = fingerprintStats
    .slice()
    .sort((a, b) => b.count - a.count)
    .slice(0, topN);

  return {
    enabled: monitorConfig.enabled,
    config: {
      slowMs: monitorConfig.slowMs,
      logEveryQuery: monitorConfig.logEveryQuery,
      topN: monitorConfig.topN,
      sampleSize: monitorConfig.sampleSize,
      slowExplain: monitorConfig.slowExplain,
    },
    counters: { ...dbStats.counters },
    concurrency: {
      inFlight: dbStats.inFlight,
      maxInFlight: dbStats.maxInFlight,
    },
    latencyMs: {
      avg: avgMs !== null ? Number(avgMs.toFixed(2)) : null,
      min: dbStats.durationMin !== null ? Number(dbStats.durationMin.toFixed(2)) : null,
      max: dbStats.durationMax !== null ? Number(dbStats.durationMax.toFixed(2)) : null,
      p50: percentiles.p50,
      p95: percentiles.p95,
      p99: percentiles.p99,
      samples: sampleCount,
    },
    histogram,
    topSlow,
    topFrequent,
    startedAt: new Date(dbStats.startedAt).toISOString(),
    lastResetAt: new Date(dbStats.lastResetAt).toISOString(),
    now: new Date(now).toISOString(),
  };
}

/**
 * Se habilitado, grava "snapshots" periódicos no arquivo de monitor.
 * Útil para investigar picos após o ocorrido, mesmo sem dashboard em tempo real.
 */
if (monitorConfig.enabled && monitorConfig.snapshotEveryMs > 0) {
  const snapshotTimer = setInterval(() => {
    const entry = buildMonitorLogEntry({ event: 'snapshot' });
    entry.stats = getDbStats();
    dbMonitorLogger.log(entry);
  }, monitorConfig.snapshotEveryMs);

  // unref: permite o processo encerrar mesmo com timer ativo
  if (typeof snapshotTimer.unref === 'function') {
    snapshotTimer.unref();
  }
}

/**
 * Calcula percentis aproximados (p50/p95/p99) usando histograma.
 * Não precisa ordenar todas as amostras, é O(buckets).
 *
 * @returns {{p50:number|null, p95:number|null, p99:number|null}}
 */
function calculatePercentiles() {
  const total = dbStats.durationCount;
  if (!total) {
    return { p50: null, p95: null, p99: null };
  }

  const targets = [
    { key: 'p50', target: Math.ceil(total * 0.5) },
    { key: 'p95', target: Math.ceil(total * 0.95) },
    { key: 'p99', target: Math.ceil(total * 0.99) },
  ];

  const results = {
    p50: null,
    p95: null,
    p99: null,
  };

  let cumulative = 0;
  const buckets = dbStats.histogramBuckets;
  const counts = dbStats.histogramCounts;

  for (let i = 0; i < counts.length; i += 1) {
    const count = counts[i];
    if (!count) continue;

    cumulative += count;

    for (const item of targets) {
      if (results[item.key] !== null) continue;
      if (cumulative >= item.target) {
        if (i < buckets.length) results[item.key] = buckets[i];
        else {
          results[item.key] = dbStats.durationMax !== null ? Number(dbStats.durationMax.toFixed(2)) : buckets[buckets.length - 1];
        }
      }
    }

    if (results.p50 !== null && results.p95 !== null && results.p99 !== null) break;
  }

  return results;
}

/**
 * Trunca textos longos para evitar logs gigantes.
 * Anexa o tamanho original ao final: "...[1234]"
 *
 * @param {unknown} value Texto/objeto a ser convertido em string
 * @param {number} [maxLength=SQL_LOG_MAX]
 * @returns {string}
 */
function truncateText(value, maxLength = SQL_LOG_MAX) {
  const text = String(value ?? '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...[${text.length}]`;
}

/**
 * Remove comentários do SQL para melhorar normalização/fingerprint.
 * Suporta:
 * - /* ... *\/
 * - -- ...
 * - # ...
 *
 * @param {unknown} sql
 * @returns {string}
 */
function stripSqlComments(sql) {
  return String(sql ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--.*$/gm, ' ')
    .replace(/#.*$/gm, ' ');
}

/**
 * Normaliza SQL para agrupamento e fingerprint:
 * - remove comentários
 * - substitui strings por '?'
 * - substitui números por '?'
 * - normaliza whitespace
 * - retorna em UPPERCASE
 *
 * Importante: isso NÃO é parser SQL completo, é heurística prática para monitor.
 *
 * @param {unknown} sql
 * @returns {string}
 */
function normalizeSql(sql) {
  let normalized = stripSqlComments(sql);
  normalized = normalized.replace(/'(?:\\'|''|[^'])*'/g, '?');
  normalized = normalized.replace(/"(?:\\"|""|[^"])*"/g, '?');
  normalized = normalized.replace(/\b0x[0-9a-f]+\b/gi, '?');
  normalized = normalized.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '?');
  normalized = normalized.replace(/\b\d+(\.\d+)?\b/g, '?');
  normalized = normalized.replace(/\s+/g, ' ').trim();
  return normalized.toUpperCase();
}

/**
 * Detecta o tipo principal da query pelo primeiro token SQL.
 * Isso é usado para:
 * - métricas agregadas por tipo (SELECT/INSERT/UPDATE...)
 * - heurísticas como "slowExplain apenas para SELECT"
 *
 * @param {unknown} sql
 * @returns {'SELECT'|'INSERT'|'UPDATE'|'DELETE'|'DDL'|'OTHER'}
 */
function getQueryType(sql) {
  const cleaned = stripSqlComments(sql).trim().toUpperCase();
  const [firstWord] = cleaned.split(/\s+/);
  switch (firstWord) {
    case 'SELECT':
    case 'WITH':
    case 'SHOW':
    case 'DESC':
    case 'DESCRIBE':
    case 'EXPLAIN':
      return 'SELECT';
    case 'INSERT':
    case 'REPLACE':
      return 'INSERT';
    case 'UPDATE':
      return 'UPDATE';
    case 'DELETE':
      return 'DELETE';
    case 'CREATE':
    case 'ALTER':
    case 'DROP':
    case 'TRUNCATE':
    case 'RENAME':
      return 'DDL';
    default:
      return 'OTHER';
  }
}

/**
 * Deduz a operação de escrita para métricas (write counter).
 * Ex:
 * - INSERT -> insert
 * - INSERT ... ON DUPLICATE -> upsert
 * - REPLACE -> replace
 *
 * @param {string} normalizedSql SQL normalizado
 * @param {string} queryType Tipo deduzido
 * @returns {'insert'|'upsert'|'replace'|'update'|'delete'|null}
 */
function getWriteOperation(normalizedSql, queryType) {
  if (!normalizedSql) return null;
  if (queryType === 'INSERT') {
    if (normalizedSql.startsWith('REPLACE')) return 'replace';
    if (normalizedSql.includes('ON DUPLICATE KEY UPDATE')) return 'upsert';
    return 'insert';
  }
  if (queryType === 'UPDATE') return 'update';
  if (queryType === 'DELETE') return 'delete';
  return null;
}

/**
 * Extrai um nome de tabela do SQL (heurística).
 * Funciona bem para queries simples (FROM/INTO/UPDATE).
 * Pode falhar em SQL complexo, joins, subqueries, etc.
 *
 * @param {unknown} sql SQL original
 * @param {string} queryType Tipo da query
 * @returns {string|null} Nome da tabela ou null se não detectável
 */
function extractTableName(sql, queryType) {
  const cleaned = stripSqlComments(sql).replace(/\s+/g, ' ').trim();
  let match = null;

  if (queryType === 'SELECT') {
    match = /FROM\s+([`"\[]?[\w.-]+[`"\]]?)/i.exec(cleaned);
  } else if (queryType === 'INSERT') {
    match = /INTO\s+([`"\[]?[\w.-]+[`"\]]?)/i.exec(cleaned);
  } else if (queryType === 'UPDATE') {
    match = /UPDATE\s+([`"\[]?[\w.-]+[`"\]]?)/i.exec(cleaned);
  } else if (queryType === 'DELETE') {
    match = /FROM\s+([`"\[]?[\w.-]+[`"\]]?)/i.exec(cleaned);
  } else if (queryType === 'DDL') {
    match = /TABLE\s+([`"\[]?[\w.-]+[`"\]]?)/i.exec(cleaned);
    if (!match) {
      match = /(DATABASE|SCHEMA)\s+([`"\[]?[\w.-]+[`"\]]?)/i.exec(cleaned);
    }
  }

  if (!match) return null;
  const raw = match[2] || match[1];
  return raw ? raw.replace(/[`"\[\]]/g, '') : null;
}

/**
 * Extrai SQL e params do formato suportado pelo mysql2:
 * - execute(sql, params)
 * - execute({sql, values}, params?)
 *
 * @param {any[]} args Args recebidos em execute/query
 * @returns {{sql: string, params: any}}
 */
function extractSqlAndParams(args) {
  const first = args[0];
  if (first && typeof first === 'object' && typeof first.sql === 'string') {
    const params = first.values ?? args[1] ?? [];
    return { sql: first.sql, params };
  }
  return { sql: first ?? '', params: args[1] ?? [] };
}

/**
 * Implementação simples de FNV-1a (32-bit) para gerar hash estável.
 * Serve para gerar fingerprint curto e barato.
 *
 * @param {string} input
 * @returns {string} hash em hex (8 chars)
 */
function fnv1aHash(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Cria fingerprint estável baseado no SQL normalizado.
 * @param {string} normalizedSql
 * @returns {string}
 */
function createFingerprint(normalizedSql) {
  return `fp:${fnv1aHash(normalizedSql)}`;
}

/**
 * Mascara strings sensíveis para logs.
 * Regras:
 * - email -> a***@dominio
 * - jwt -> [JWT]
 * - token longo -> [REDACTED:n]
 * - strings enormes -> truncadas
 *
 * @param {string} value
 * @returns {string}
 */
function maskString(value) {
  if (EMAIL_REGEX.test(value)) {
    return value.replace(EMAIL_REGEX, (_, user, domain) => {
      const maskedUser = user.length > 1 ? `${user[0]}***` : '*';
      return `${maskedUser}@${domain}`;
    });
  }
  if (JWT_REGEX.test(value)) {
    return '[JWT]';
  }
  if (value.length > 40 && TOKEN_LIKE_REGEX.test(value) && !value.includes(' ')) {
    return `[REDACTED:${value.length}]`;
  }
  if (value.length > 120) {
    return `${value.slice(0, 40)}...[${value.length}]`;
  }
  return value;
}

/**
 * Mascara valores de parâmetros recursivamente.
 * Isso evita vazar PII/tokens em logs, e reduz volume.
 *
 * @param {any} value
 * @param {number} [depth=0] Profundidade (limita recursão)
 * @returns {any} Valor mascarado/serializável
 */
function maskParamValue(value, depth = 0) {
  if (value === undefined) return null;
  if (value === null) return null;

  if (typeof value === 'string') return maskString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `[Buffer:${value.length}]`;

  if (Array.isArray(value)) {
    if (depth > 2) return `[Array:${value.length}]`;
    const truncated = value.slice(0, PARAMS_LOG_MAX).map((item) => maskParamValue(item, depth + 1));
    if (value.length > PARAMS_LOG_MAX) truncated.push(`...(+${value.length - PARAMS_LOG_MAX})`);
    return truncated;
  }

  if (typeof value === 'object') {
    if (depth > 1) return '[Object]';
    const entries = Object.entries(value);
    const out = {};
    const limited = entries.slice(0, PARAMS_LOG_MAX);
    for (const [key, item] of limited) out[key] = maskParamValue(item, depth + 1);
    if (entries.length > PARAMS_LOG_MAX) out.__truncated = `+${entries.length - PARAMS_LOG_MAX}`;
    return out;
  }

  return `[${typeof value}]`;
}

/**
 * Mascara params (array, objeto ou valor único).
 * @param {any} params
 * @returns {any}
 */
function maskParams(params) {
  if (params === undefined) return undefined;
  if (Array.isArray(params)) return params.map((param) => maskParamValue(param));
  if (typeof params === 'object' && params !== null) return maskParamValue(params);
  return maskParamValue(params);
}

/**
 * Extrai estatísticas do resultado do mysql2.
 * mysql2 pode retornar:
 * - [rows, fields]
 * - OkPacket / ResultSetHeader com affectedRows
 *
 * @param {any} result
 * @returns {{rowCount: number|undefined, affectedRows: number|undefined}}
 */
function extractResultStats(result) {
  if (result === undefined || result === null) {
    return { rowCount: undefined, affectedRows: undefined };
  }

  let rows = result;
  const looksLikeFields = Array.isArray(result) && result.length === 2 && ((Array.isArray(result[1]) && (result[1].length === 0 || typeof result[1][0] === 'object')) || result[1] === undefined || result[1] === null);

  if (looksLikeFields) {
    rows = result[0];
  }

  let rowCount;
  let affectedRows;

  if (Array.isArray(rows)) {
    rowCount = rows.length;
  } else if (rows && typeof rows === 'object') {
    if (typeof rows.affectedRows === 'number') affectedRows = rows.affectedRows;
    if (typeof rows.rowCount === 'number') rowCount = rows.rowCount;
  }

  return { rowCount, affectedRows };
}

/**
 * Registra a duração em amostra circular para inspeção rápida.
 * @param {number} durationMs
 */
function recordSample(durationMs) {
  if (monitorConfig.sampleSize <= 0) return;

  if (dbStats.samples.length < monitorConfig.sampleSize) {
    dbStats.samples.push(durationMs);
    return;
  }

  const idx = dbStats.sampleCursor % monitorConfig.sampleSize;
  dbStats.samples[idx] = durationMs;
  dbStats.sampleCursor += 1;
}

/**
 * Incrementa bucket do histograma com base na duração.
 * @param {number} durationMs
 */
function recordHistogram(durationMs) {
  const buckets = dbStats.histogramBuckets;
  for (let i = 0; i < buckets.length; i += 1) {
    if (durationMs <= buckets[i]) {
      dbStats.histogramCounts[i] += 1;
      return;
    }
  }
  dbStats.histogramCounts[buckets.length] += 1;
}

/**
 * Remove fingerprints antigas para limitar memória.
 * Estratégia: remove ~10% mais antigos quando passar do limite.
 */
function maybePruneFingerprints() {
  if (dbStats.fingerprints.size <= MAX_FINGERPRINTS) return;

  const entries = Array.from(dbStats.fingerprints.values()).sort((a, b) => a.lastSeenAt - b.lastSeenAt);
  const removeCount = Math.max(1, Math.ceil(entries.length * 0.1));
  for (let i = 0; i < removeCount; i += 1) {
    dbStats.fingerprints.delete(entries[i].fingerprint);
  }
}

/**
 * Atualiza contadores globais e contadores por fingerprint.
 * @param {{
 *  fingerprint: string,
 *  normalizedSql: string,
 *  type: string,
 *  table: string|null,
 *  durationMs: number,
 *  ok: boolean,
 *  rowCount: number|undefined,
 *  affectedRows: number|undefined,
 *  isSlow: boolean
 * }} payload
 */
function recordStats({ fingerprint, normalizedSql, type, table, durationMs, ok, rowCount, affectedRows, isSlow }) {
  dbStats.counters.total += 1;
  if (!ok) dbStats.counters.error += 1;
  if (isSlow) dbStats.counters.slow += 1;

  dbStats.durationCount += 1;
  dbStats.durationTotal += durationMs;
  dbStats.durationMin = dbStats.durationMin === null ? durationMs : Math.min(dbStats.durationMin, durationMs);
  dbStats.durationMax = dbStats.durationMax === null ? durationMs : Math.max(dbStats.durationMax, durationMs);

  recordSample(durationMs);
  recordHistogram(durationMs);

  let entry = dbStats.fingerprints.get(fingerprint);
  if (!entry) {
    entry = {
      fingerprint,
      normalizedSql: truncateText(normalizedSql, 600),
      type,
      table,
      count: 0,
      errorCount: 0,
      slowCount: 0,
      totalMs: 0,
      maxMs: 0,
      minMs: null,
      lastMs: 0,
      lastSeenAt: 0,
      lastRowCount: null,
      lastAffectedRows: null,
    };
    dbStats.fingerprints.set(fingerprint, entry);
    maybePruneFingerprints();
  }

  entry.count += 1;
  if (!ok) entry.errorCount += 1;
  if (isSlow) entry.slowCount += 1;

  entry.totalMs += durationMs;
  entry.maxMs = Math.max(entry.maxMs, durationMs);
  entry.minMs = entry.minMs === null ? durationMs : Math.min(entry.minMs, durationMs);
  entry.lastMs = durationMs;
  entry.lastSeenAt = Date.now();

  if (rowCount !== undefined) entry.lastRowCount = rowCount;
  if (affectedRows !== undefined) entry.lastAffectedRows = affectedRows;
}

/**
 * Monta um evento de log padronizado (JSON) para arquivo.
 * @param {object} payload
 * @returns {object}
 */
function buildMonitorLogEntry({ event, durationMs, type, table, fingerprint, normalizedSql, sql, rowCount, affectedRows, traceId, error, params }) {
  const entry = {
    ts: new Date().toISOString(),
    event,
    durationMs: durationMs !== undefined && durationMs !== null ? Number(durationMs.toFixed(2)) : null,
    type: type ?? null,
    table: table ?? null,
    fingerprint: fingerprint ?? null,
    normalizedSql: normalizedSql ? truncateText(normalizedSql, 600) : null,
    sql: sql ? truncateText(sql) : null,
    rowCount: rowCount ?? null,
    affectedRows: affectedRows ?? null,
    traceId: traceId ?? null,
    errorCode: error?.code ?? null,
    errorMessage: error?.message ?? null,
  };
  if (params !== undefined) entry.params = params;
  return entry;
}

/**
 * Recupera a implementação ORIGINAL de execute() para um executor (pool ou connection).
 * Isso é importante porque a gente "wrapa" execute/query para medir latência.
 * Em alguns casos precisamos rodar EXPLAIN com a função original para evitar recursão infinita.
 *
 * @param {any} executor Pool ou Connection
 * @returns {Function|null}
 */
function getOriginalExecute(executor) {
  if (!executor) return null;
  if (executor === pool) return poolExecuteOriginal;
  if (executor[MONITOR_TAG]?.originalExecute) return executor[MONITOR_TAG].originalExecute;
  if (typeof executor.execute === 'function') return executor.execute.bind(executor);
  return null;
}

/**
 * Recupera a implementação ORIGINAL de query() para um executor (pool ou connection).
 * @param {any} executor
 * @returns {Function|null}
 */
function getOriginalQuery(executor) {
  if (!executor) return null;
  if (executor === pool) return poolQueryOriginal;
  if (executor[MONITOR_TAG]?.originalQuery) return executor[MONITOR_TAG].originalQuery;
  if (typeof executor.query === 'function') return executor.query.bind(executor);
  return null;
}

/**
 * Executa EXPLAIN em SELECT lento (quando habilitado).
 * Observações:
 * - roda em background (setImmediate) para não atrasar a resposta principal
 * - usa função original para evitar "monitorar o explain do explain"
 *
 * @param {{sql:string, params:any, executor:any, traceId?:string}} payload
 */
async function runExplain({ sql, params, executor, traceId }) {
  const original = getOriginalExecute(executor) || getOriginalQuery(executor);
  if (!original) return;

  const explainSql = String(sql ?? '')
    .trim()
    .toUpperCase()
    .startsWith('EXPLAIN')
    ? sql
    : `EXPLAIN ${sql}`;

  try {
    await original(explainSql, params);
    logger.debug('EXPLAIN para query lenta executado.', {
      traceId,
      normalizedSql: truncateText(normalizeSql(explainSql), 600),
    });
  } catch (error) {
    logger.warn('Falha ao executar EXPLAIN para query lenta.', {
      traceId,
      errorCode: error.code,
      errorMessage: error.message,
    });
  }
}

/**
 * Executor monitorado:
 * - mede duração (hrtime)
 * - atualiza stats
 * - escreve logs (slow/error e opcionalmente "every query")
 * - emite métricas se METRICS_ACTIVE
 *
 * @param {{
 *  executor: any,
 *  originalFn: Function,
 *  args: any[],
 *  traceId?: string,
 *  allowExplain?: boolean
 * }} cfg
 * @returns {Promise<any>}
 */
async function runMonitored({ executor, originalFn, args, traceId, allowExplain = false }) {
  if (typeof originalFn !== 'function') {
    throw new Error('Executor inválido para query.');
  }

  const shouldMonitor = monitorConfig.enabled;
  const shouldMeasure = shouldMonitor || METRICS_ACTIVE;

  if (!shouldMeasure) {
    return originalFn(...args);
  }

  const { sql, params } = extractSqlAndParams(args);
  const sqlText = String(sql ?? '');
  const start = process.hrtime.bigint();

  // in-flight do monitor
  if (shouldMonitor) {
    dbStats.inFlight += 1;
    if (dbStats.inFlight > dbStats.maxInFlight) dbStats.maxInFlight = dbStats.inFlight;
  }

  // in-flight da métrica externa
  if (METRICS_ACTIVE) {
    dbInFlightMetric += 1;
    setDbInFlight(dbInFlightMetric);
  }

  let ok = false;
  let result;
  let error;

  try {
    result = await originalFn(...args);
    ok = true;
    return result;
  } catch (err) {
    error = err;
    throw err;
  } finally {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;

    if (shouldMonitor) dbStats.inFlight = Math.max(0, dbStats.inFlight - 1);

    if (METRICS_ACTIVE) {
      dbInFlightMetric = Math.max(0, dbInFlightMetric - 1);
      setDbInFlight(dbInFlightMetric);
    }

    const type = getQueryType(sqlText);
    const table = extractTableName(sqlText, type);
    const normalizedSql = normalizeSql(sqlText);
    const fingerprint = createFingerprint(normalizedSql);
    const writeOperation = getWriteOperation(normalizedSql, type);
    const isSlow = durationMs >= monitorConfig.slowMs;
    const { rowCount, affectedRows } = extractResultStats(result);

    if (shouldMonitor) {
      recordStats({
        fingerprint,
        normalizedSql,
        type,
        table,
        durationMs,
        ok,
        rowCount,
        affectedRows,
        isSlow,
      });
    }

    if (METRICS_ACTIVE) {
      recordDbQuery({ durationMs, type, table, ok, isSlow });
      if (!ok) recordError('db');
      if (ok && writeOperation) recordDbWrite({ operation: writeOperation, table });
    }

    const baseLogData = {
      durationMs,
      type,
      table,
      fingerprint,
      normalizedSql,
      sql: sqlText,
      rowCount,
      affectedRows,
      traceId,
    };

    // Log de query normal (opcional) — cuidado em produção
    if (shouldMonitor && monitorConfig.logEveryQuery && ok && !isSlow) {
      const maskedParams = maskParams(params);
      logger.debug('DB query executada.', {
        durationMs: Number(durationMs.toFixed(2)),
        type,
        table,
        fingerprint,
        normalizedSql: truncateText(normalizedSql, 600),
        sql: truncateText(sqlText),
        params: maskedParams,
        rowCount,
        affectedRows,
        traceId,
      });
      dbMonitorLogger.log(buildMonitorLogEntry({ event: 'query', ...baseLogData, params: maskedParams }));
    }

    // Slow query
    if (shouldMonitor && isSlow) {
      logger.warn('DB query lenta detectada.', {
        durationMs: Number(durationMs.toFixed(2)),
        type,
        table,
        fingerprint,
        normalizedSql: truncateText(normalizedSql, 600),
        sql: truncateText(sqlText),
        rowCount,
        affectedRows,
        traceId,
      });
      dbMonitorLogger.log(buildMonitorLogEntry({ event: 'slow', ...baseLogData }));

      if (allowExplain && monitorConfig.slowExplain && type === 'SELECT') {
        setImmediate(() => {
          runExplain({ sql: sqlText, params, executor, traceId });
        });
      }
    }

    // Erro
    if (shouldMonitor && !ok) {
      logger.error('Erro na consulta SQL.', {
        durationMs: Number(durationMs.toFixed(2)),
        type,
        table,
        fingerprint,
        normalizedSql: truncateText(normalizedSql, 600),
        sql: truncateText(sqlText),
        errorCode: error?.code,
        errorMessage: error?.message,
        traceId,
      });
      dbMonitorLogger.log(buildMonitorLogEntry({ event: 'error', ...baseLogData, error }));
    }
  }
}

/**
 * "Wrapa" uma conexão individual retornada por pool.getConnection()
 * para que connection.execute/query também sejam monitorados.
 *
 * Importante:
 * - evita wrap duplicado (MONITOR_TAG.wrapped)
 * - salva referência das funções originais (para fallback)
 *
 * @param {import('mysql2/promise').PoolConnection} connection
 * @returns {import('mysql2/promise').PoolConnection}
 */
function wrapConnection(connection) {
  if (!connection || connection[MONITOR_TAG]?.wrapped) {
    return connection;
  }

  const originalExecute = connection.execute?.bind(connection);
  const originalQuery = connection.query?.bind(connection);

  if (typeof originalExecute === 'function') {
    connection.execute = (...args) =>
      runMonitored({
        executor: connection,
        originalFn: originalExecute,
        args,
        traceId: connection.__traceId,
        allowExplain: true,
      });
  }

  if (typeof originalQuery === 'function') {
    connection.query = (...args) =>
      runMonitored({
        executor: connection,
        originalFn: originalQuery,
        args,
        traceId: connection.__traceId,
        allowExplain: true,
      });
  }

  connection[MONITOR_TAG] = {
    wrapped: true,
    originalExecute,
    originalQuery,
  };

  return connection;
}

/**
 * Referências das funções originais do pool (antes do wrap).
 * Usadas para:
 * - evitar recursão
 * - permitir EXPLAIN e execuções internas sem duplicar medição
 */
let poolExecuteOriginal;
let poolQueryOriginal;
let poolGetConnectionOriginal;

const poolMonitorState = pool[MONITOR_TAG];

// Se já estava wrapado (ex: hot reload), reaproveita originais
if (poolMonitorState?.wrapped) {
  poolExecuteOriginal = poolMonitorState.originalExecute || pool.execute.bind(pool);
  poolQueryOriginal = poolMonitorState.originalQuery || pool.query.bind(pool);
  poolGetConnectionOriginal = poolMonitorState.originalGetConnection || pool.getConnection.bind(pool);
} else {
  // Primeira vez: salva originais e faz wrap
  poolExecuteOriginal = pool.execute.bind(pool);
  poolQueryOriginal = pool.query.bind(pool);
  poolGetConnectionOriginal = pool.getConnection.bind(pool);

  pool.execute = (...args) =>
    runMonitored({
      executor: pool,
      originalFn: poolExecuteOriginal,
      args,
    });

  pool.query = (...args) =>
    runMonitored({
      executor: pool,
      originalFn: poolQueryOriginal,
      args,
    });

  pool.getConnection = async (...args) => {
    const connection = await poolGetConnectionOriginal(...args);
    return wrapConnection(connection);
  };

  pool[MONITOR_TAG] = {
    wrapped: true,
    originalExecute: poolExecuteOriginal,
    originalQuery: poolQueryOriginal,
    originalGetConnection: poolGetConnectionOriginal,
  };
}

/**
 * Valida conectividade do banco no boot:
 * - pega conexão do pool
 * - executa ping
 * - devolve conexão
 *
 * Se falhar, encerra o processo (fail fast).
 *
 * @returns {Promise<void>}
 */
async function validateConnection() {
  try {
    const connection = await pool.getConnection();
    await connection.ping();
    connection.release();
    logger.info('Pool de conexões com o MySQL criado e testado com sucesso.');
  } catch (error) {
    logger.error('Erro ao conectar ao MySQL:', error.message);
    process.exit(1);
  }
}

/**
 * Evita validar conexão quando rodando scripts de init/migration.
 * @type {boolean}
 */
const isInitScript = process.argv[1]?.endsWith(`${path.sep}database${path.sep}init.js`);
if (!isInitScript) {
  validateConnection();
}

/**
 * Encerra o pool de conexões do MySQL.
 * Importante para desligamento gracioso (SIGTERM/SIGINT).
 *
 * @returns {Promise<void>}
 */
export async function closePool() {
  try {
    await pool.end();
    logger.info('Pool de conexões MySQL encerrado com sucesso.');
  } catch (error) {
    logger.error('Erro ao encerrar pool de conexões:', error.message);
    process.exit(1);
  }
}

/**
 * Guarda para evitar shutdown duplicado (SIGINT + SIGTERM, etc).
 * @type {boolean}
 */
let isClosing = false;

/**
 * Desligamento gracioso:
 * - garante execução única
 * - fecha pool
 * - encerra processo
 *
 * @param {string} signal Nome do sinal recebido (SIGINT/SIGTERM)
 * @returns {Promise<void>}
 */
async function shutdown(signal) {
  if (isClosing) return;
  isClosing = true;

  logger.info(`Encerrando aplicação (${signal}).`);
  try {
    await closePool();
  } finally {
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

/**
 * Erro padrão para operações de banco.
 * Inclui metadados úteis para debug:
 * - errorCode/errorNumber/sqlState (MySQL)
 * - sql/params originais (cuidado ao exibir isso em logs externos)
 */
export class DatabaseError extends Error {
  /**
   * @param {string} message Mensagem de alto nível
   * @param {any} originalError Erro original do mysql2
   * @param {string} sql SQL executado
   * @param {any} params Parâmetros utilizados
   */
  constructor(message, originalError, sql, params) {
    super(message);
    this.name = 'DatabaseError';
    this.originalError = originalError;
    this.sql = sql;
    this.params = params;
    this.errorCode = originalError?.code;
    this.errorNumber = originalError?.errno;
    this.sqlState = originalError?.sqlState;
  }
}

const VALID_TABLES = Object.values(TABLES);

/**
 * Valida se o nome da tabela está na allow-list.
 * Protege contra uso indevido de tableName vindo de input externo.
 *
 * @param {string} tableName
 * @throws {Error} Se a tabela não for permitida
 */
export function validateTableName(tableName) {
  if (!VALID_TABLES.includes(tableName)) {
    throw new Error(`Tabela inválida: ${tableName}`);
  }
}

/**
 * Converte undefined em null para parâmetros SQL.
 * mysql2 não lida bem com undefined em binds.
 *
 * @param {Array<any>} params
 * @returns {Array<any>}
 */
export function sanitizeParams(params) {
  return params.map((param) => (param === undefined ? null : param));
}

/**
 * Executa uma consulta SQL (execute) com:
 * - sanitização de parâmetros (undefined -> null)
 * - suporte a pool ou conexão (em transações)
 * - suporte a traceId (correlação)
 * - monitor/métricas (quando habilitado)
 *
 * Assinatura atual (recomendada):
 * executeQuery(sql, params, connection, options)
 *
 * Compatibilidade (depreciada):
 * executeQuery(sql, params, options)  // options como 3º parâmetro
 *
 * @param {string} sql SQL a executar
 * @param {Array<any>} [params=[]] Parâmetros do bind
 * @param {import('mysql2/promise').PoolConnection|null} [connection=null] Conexão opcional (transação)
 * @param {{traceId?: string}|null} [options] Opções (ex: traceId)
 * @returns {Promise<any>} Resultado (rows ou ok packet)
 */
export async function executeQuery(sql, params = [], connection = null, options = null) {
  // Compat: options no 3º parâmetro (depreciado)
  if (connection && !options && isValidExecuteOptions(connection)) {
    if (DEPRECATION_WARN_EXECUTEQUERY_OPTIONS_IN_3RD_PARAM) {
      logger.warn('executeQuery(): assinatura com options no 3º parâmetro está depreciada. Use executeQuery(sql, params, connection, options).');
    }
    options = connection;
    connection = null;
  }

  let executor = pool;
  let traceId = options && typeof options === 'object' ? options.traceId : undefined;

  const isConnection = connection && (typeof connection.execute === 'function' || typeof connection.query === 'function');

  if (connection) {
    if (isConnection) {
      executor = connection;
      traceId = traceId || connection.__traceId;
    } else {
      throw new Error('Parâmetro connection inválido em executeQuery. Informe uma conexão MySQL2 válida ou passe options no 4º parâmetro.');
    }
  }

  const sanitizedParams = sanitizeParams(params);
  const originalExecute = getOriginalExecute(executor);

  // Fallback (caso executor não esteja wrapado)
  if (!originalExecute || typeof originalExecute !== 'function') {
    try {
      const [results] = await executor.execute(sql, sanitizedParams);
      return results;
    } catch (error) {
      logger.error('Erro na consulta SQL.', {
        normalizedSql: truncateText(normalizeSql(sql), 600),
        sql: truncateText(sql),
        errorCode: error.code,
        errorMessage: error.message,
        traceId,
      });
      if (METRICS_ACTIVE) recordError('db');
      throw new DatabaseError(`Erro na execução da consulta: ${error.message}`, error, sql, params);
    }
  }

  // Otimização: se nada estiver ativo, executa direto
  if (!monitorConfig.enabled && !METRICS_ACTIVE) {
    try {
      const [results] = await executor.execute(sql, sanitizedParams);
      return results;
    } catch (error) {
      logger.error('Erro na consulta SQL.', {
        normalizedSql: truncateText(normalizeSql(sql), 600),
        sql: truncateText(sql),
        errorCode: error.code,
        errorMessage: error.message,
        traceId,
      });
      throw new DatabaseError(`Erro na execução da consulta: ${error.message}`, error, sql, params);
    }
  }

  // Caminho monitorado
  try {
    const result = await runMonitored({
      executor,
      originalFn: originalExecute,
      args: [sql, sanitizedParams],
      traceId,
      allowExplain: true,
    });

    // mysql2 geralmente retorna [rows, fields]
    if (Array.isArray(result)) return result[0];
    return result;
  } catch (error) {
    throw new DatabaseError(`Erro na execução da consulta: ${error.message}`, error, sql, params);
  }
}

/**
 * Busca todos os registros de uma tabela com paginação.
 * Atenção: SELECT * pode ser pesado em tabelas grandes.
 *
 * @param {string} tableName Nome da tabela (allow-list)
 * @param {number} [limit=100] Limite de linhas
 * @param {number} [offset=0] Offset
 * @returns {Promise<Array<any>>}
 */
export async function findAll(tableName, limit = 100, offset = 0) {
  validateTableName(tableName);
  const safeLimit = parseInt(limit, 10);
  const safeOffset = parseInt(offset, 10);

  if (isNaN(safeLimit) || isNaN(safeOffset)) {
    throw new Error('Limit e offset devem ser números válidos.');
  }

  const sql = `SELECT * FROM ${mysql.escapeId(tableName)} LIMIT ${safeLimit} OFFSET ${safeOffset}`;
  return executeQuery(sql);
}

/**
 * Busca um registro por ID.
 * Requer coluna "id" na tabela.
 *
 * @param {string} tableName
 * @param {number|string} id
 * @returns {Promise<any|null>}
 */
export async function findById(tableName, id) {
  validateTableName(tableName);
  const sql = `SELECT * FROM ${mysql.escapeId(tableName)} WHERE id = ?`;
  const results = await executeQuery(sql, [id]);
  return results[0] || null;
}

/**
 * Busca registros por critérios simples de igualdade (AND).
 * - criteria: { coluna: valor }
 * - options: orderBy/orderDirection/limit/offset
 *
 * @param {string} tableName
 * @param {object} criteria
 * @param {object} [options]
 * @param {number} [options.limit]
 * @param {number} [options.offset]
 * @param {string} [options.orderBy]
 * @param {'ASC'|'DESC'} [options.orderDirection='ASC']
 * @returns {Promise<Array<any>>}
 */
export async function findBy(tableName, criteria, options = {}) {
  validateTableName(tableName);
  const keys = Object.keys(criteria);

  if (keys.length === 0) {
    return findAll(tableName, options.limit, options.offset);
  }

  const whereClause = keys.map((key) => `${mysql.escapeId(key)} = ?`).join(' AND ');
  const params = Object.values(criteria);

  let sql = `SELECT * FROM ${mysql.escapeId(tableName)} WHERE ${whereClause}`;

  if (options.orderBy) {
    const direction = options.orderDirection?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
    sql += ` ORDER BY ${mysql.escapeId(options.orderBy)} ${direction}`;
  }

  if (options.limit !== undefined) {
    sql += ` LIMIT ${parseInt(options.limit, 10)}`;
  }

  if (options.offset !== undefined) {
    sql += ` OFFSET ${parseInt(options.offset, 10)}`;
  }

  return executeQuery(sql, params);
}

/**
 * Conta registros com filtro opcional.
 *
 * @param {string} tableName
 * @param {object} [criteria]
 * @returns {Promise<number>}
 */
export async function count(tableName, criteria = {}) {
  validateTableName(tableName);

  const keys = Object.keys(criteria);
  let sql = `SELECT COUNT(*) as count FROM ${mysql.escapeId(tableName)}`;
  let params = [];

  if (keys.length > 0) {
    const whereClause = keys.map((key) => `${mysql.escapeId(key)} = ?`).join(' AND ');
    sql += ` WHERE ${whereClause}`;
    params = Object.values(criteria);
  }

  const result = await executeQuery(sql, params);
  return result[0].count;
}

/**
 * Cria um novo registro.
 * @param {string} tableName
 * @param {object} data
 * @returns {Promise<object>}
 */
export async function create(tableName, data) {
  validateTableName(tableName);

  const keys = Object.keys(data);
  if (keys.length === 0) {
    throw new Error('Não é possível criar um registro com dados vazios.');
  }

  const values = Object.values(data);
  const sql = `INSERT INTO ${mysql.escapeId(tableName)} (${keys.map(mysql.escapeId).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;

  const result = await executeQuery(sql, values);
  return { id: result.insertId, ...data };
}

/**
 * Cria um novo registro ignorando duplicidade (INSERT IGNORE).
 * @param {string} tableName
 * @param {object} data
 * @returns {Promise<object|null>} null se foi ignorado
 */
export async function createIgnore(tableName, data) {
  validateTableName(tableName);

  const keys = Object.keys(data);
  if (keys.length === 0) {
    throw new Error('Não é possível criar um registro com dados vazios.');
  }

  const values = Object.values(data);
  const sql = `INSERT IGNORE INTO ${mysql.escapeId(tableName)} (${keys.map(mysql.escapeId).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;

  const result = await executeQuery(sql, values);
  if (!result.insertId) return null;
  return { id: result.insertId, ...data };
}

/**
 * Insere múltiplos registros usando INSERT ... VALUES ?
 * Nota:
 * - assume que todos os records possuem as mesmas chaves (usa records[0])
 * - converte undefined -> null (mysql2 não aceita undefined)
 *
 * @param {string} tableName
 * @param {Array<object>} records
 * @returns {Promise<number>} Quantidade de linhas afetadas
 */
export async function bulkInsert(tableName, records) {
  validateTableName(tableName);
  if (!records || records.length === 0) return 0;

  const keys = Object.keys(records[0]);
  const values = records.map((r) => keys.map((k) => (r[k] === undefined ? null : r[k])));
  const sql = `INSERT INTO ${mysql.escapeId(tableName)} (${keys.map(mysql.escapeId).join(', ')}) VALUES ?`;

  const [result] = await pool.query(sql, [values]);
  return result.affectedRows;
}

/**
 * Atualiza um registro por ID.
 * @param {string} tableName
 * @param {number|string} id
 * @param {object} data
 * @returns {Promise<boolean>}
 */
export async function update(tableName, id, data) {
  validateTableName(tableName);

  const keys = Object.keys(data);
  if (keys.length === 0) {
    throw new Error('Não é possível atualizar um registro com dados vazios.');
  }

  const sets = keys.map((key) => `${mysql.escapeId(key)} = ?`).join(', ');
  const sql = `UPDATE ${mysql.escapeId(tableName)} SET ${sets} WHERE id = ?`;
  const result = await executeQuery(sql, [...Object.values(data), id]);

  return result.affectedRows > 0;
}

/**
 * Remove um registro por ID.
 * @param {string} tableName
 * @param {number|string} id
 * @returns {Promise<boolean>}
 */
export async function remove(tableName, id) {
  validateTableName(tableName);
  const sql = `DELETE FROM ${mysql.escapeId(tableName)} WHERE id = ?`;
  const result = await executeQuery(sql, [id]);
  return result.affectedRows > 0;
}

/**
 * Insere ou atualiza (upsert) usando ON DUPLICATE KEY UPDATE.
 *
 * Regras:
 * - "data" precisa ter chaves para inserir
 * - se "data" só tiver "id", lança erro (não há o que atualizar)
 *
 * @param {string} tableName
 * @param {object} data
 * @returns {Promise<any>}
 */
export async function upsert(tableName, data) {
  validateTableName(tableName);

  const keys = Object.keys(data);
  if (keys.length === 0) {
    throw new Error('Não é possível fazer upsert com dados vazios.');
  }

  const updateData = { ...data };
  if (updateData.id) delete updateData.id;

  if (Object.keys(updateData).length === 0) {
    throw new Error('Não é possível fazer upsert apenas com id. Informe campos adicionais para atualizar.');
  }

  const insertKeys = keys.map(mysql.escapeId).join(', ');
  const insertPlaceholders = keys.map(() => '?').join(', ');
  const updateSets = Object.keys(updateData)
    .map((key) => `${mysql.escapeId(key)} = ?`)
    .join(', ');

  const sql = `INSERT INTO ${mysql.escapeId(tableName)} (${insertKeys})
               VALUES (${insertPlaceholders})
               ON DUPLICATE KEY UPDATE ${updateSets}`;

  const params = [...Object.values(data), ...Object.values(updateData)];
  return executeQuery(sql, params);
}

/**
 * Executa operações dentro de uma transação.
 * Uso esperado:
 * await withTransaction(async (conn) => {
 *   await executeQuery(sql1, p1, conn)
 *   await executeQuery(sql2, p2, conn)
 * })
 *
 * @param {(connection: import('mysql2/promise').PoolConnection) => Promise<any>} callback
 * @returns {Promise<any>}
 */
export async function withTransaction(callback) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await callback(connection);
    await connection.commit();
    return result;
  } catch (err) {
    await connection.rollback();
    logger.error('Transação revertida devido a um erro:', err);
    throw err;
  } finally {
    connection.release();
  }
}
