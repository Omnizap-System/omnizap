#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE_TYPE="${RELEASE_TYPE:-patch}"
RELEASE_FORCE_VERSION="${RELEASE_FORCE_VERSION:-}"
RELEASE_PATCH_ROLLOVER_ENABLED="${RELEASE_PATCH_ROLLOVER_ENABLED:-1}"
RELEASE_PATCH_ROLLOVER_AT="${RELEASE_PATCH_ROLLOVER_AT:-10}"
RELEASE_GIT_AUTO_COMMIT="${RELEASE_GIT_AUTO_COMMIT:-1}"
RELEASE_GIT_AUTO_PUSH="${RELEASE_GIT_AUTO_PUSH:-1}"
RELEASE_GIT_REMOTE="${RELEASE_GIT_REMOTE:-origin}"
RELEASE_GIT_BRANCH="${RELEASE_GIT_BRANCH:-}"
RELEASE_GIT_PRE_COMMIT_MESSAGE="${RELEASE_GIT_PRE_COMMIT_MESSAGE:-chore(release): auto-commit before release}"
RELEASE_GIT_COMMIT_VERSION="${RELEASE_GIT_COMMIT_VERSION:-1}"
RELEASE_GIT_VERSION_COMMIT_PREFIX="${RELEASE_GIT_VERSION_COMMIT_PREFIX:-chore(release): v}"
RELEASE_GIT_TAG_CREATE="${RELEASE_GIT_TAG_CREATE:-1}"
RELEASE_GIT_TAG_PUSH="${RELEASE_GIT_TAG_PUSH:-1}"
RELEASE_GIT_TAG_ANNOTATED="${RELEASE_GIT_TAG_ANNOTATED:-1}"
RELEASE_GITHUB_RELEASE="${RELEASE_GITHUB_RELEASE:-1}"
RELEASE_REQUIRE_GITHUB_RELEASE="${RELEASE_REQUIRE_GITHUB_RELEASE:-1}"
RELEASE_GITHUB_TAG_PREFIX="${RELEASE_GITHUB_TAG_PREFIX:-v}"
RELEASE_GITHUB_NAME_PREFIX="${RELEASE_GITHUB_NAME_PREFIX:-v}"
RELEASE_GITHUB_GENERATE_NOTES="${RELEASE_GITHUB_GENERATE_NOTES:-1}"
RELEASE_GITHUB_PRERELEASE="${RELEASE_GITHUB_PRERELEASE:-}"
RELEASE_GITHUB_DRAFT="${RELEASE_GITHUB_DRAFT:-0}"
RELEASE_GITHUB_LATEST="${RELEASE_GITHUB_LATEST:-1}"
RELEASE_GITHUB_TARGET="${RELEASE_GITHUB_TARGET:-}"
RELEASE_GITHUB_RELEASE_INCLUDE_CHANGED_FILES="${RELEASE_GITHUB_RELEASE_INCLUDE_CHANGED_FILES:-1}"
RELEASE_GITHUB_RELEASE_MAX_FILES="${RELEASE_GITHUB_RELEASE_MAX_FILES:-300}"
RELEASE_REQUIRE_DUAL_PUBLISH="${RELEASE_REQUIRE_DUAL_PUBLISH:-1}"
RELEASE_VERIFY_UNIFIED_VERSION="${RELEASE_VERIFY_UNIFIED_VERSION:-1}"
RELEASE_WIKI_SYNC="${RELEASE_WIKI_SYNC:-1}"
RELEASE_WIKI_SYNC_REQUIRED="${RELEASE_WIKI_SYNC_REQUIRED:-0}"
RELEASE_WIKI_SYNC_COMMAND="${RELEASE_WIKI_SYNC_COMMAND:-bash ./scripts/wiki-sync.sh}"
RELEASE_VERIFY_PRIMARY_REGISTRY="${RELEASE_VERIFY_PRIMARY_REGISTRY:-${DEPLOY_PACKAGE_REGISTRY:-https://npm.pkg.github.com}}"
RELEASE_VERIFY_SECONDARY_REGISTRY="${RELEASE_VERIFY_SECONDARY_REGISTRY:-${DEPLOY_PACKAGE_SECONDARY_REGISTRY:-https://registry.npmjs.org}}"
RELEASE_VERIFY_PRIMARY_TOKEN_KEYS="${RELEASE_VERIFY_PRIMARY_TOKEN_KEYS:-DEPLOY_PACKAGE_TOKEN,DEPLOY_GITHUB_TOKEN,GITHUB_TOKEN,GH_TOKEN,NPM_TOKEN,NODE_AUTH_TOKEN}"
RELEASE_VERIFY_SECONDARY_TOKEN_KEYS="${RELEASE_VERIFY_SECONDARY_TOKEN_KEYS:-DEPLOY_PACKAGE_SECONDARY_TOKEN,NPM_TOKEN,NODE_AUTH_TOKEN}"
RELEASE_VERIFY_MAX_ATTEMPTS="${RELEASE_VERIFY_MAX_ATTEMPTS:-12}"
RELEASE_VERIFY_RETRY_DELAY_SECONDS="${RELEASE_VERIFY_RETRY_DELAY_SECONDS:-10}"
TMP_NPMRC_FILES=()
TMP_MISC_FILES=()

case "$RELEASE_TYPE" in
  patch|minor|major|prepatch|preminor|premajor|prerelease)
    ;;
  *)
    printf '[release] RELEASE_TYPE inválido: %s\n' "$RELEASE_TYPE" >&2
    printf '[release] Valores permitidos: patch, minor, major, prepatch, preminor, premajor, prerelease\n' >&2
    exit 1
    ;;
esac

log() {
  printf '[release] %s\n' "$*"
}

cleanup_tmp_files() {
  for npmrc_tmp in "${TMP_NPMRC_FILES[@]:-}"; do
    if [ -n "$npmrc_tmp" ] && [ -f "$npmrc_tmp" ]; then
      rm -f "$npmrc_tmp"
    fi
  done
  for tmp_file in "${TMP_MISC_FILES[@]:-}"; do
    if [ -n "$tmp_file" ] && [ -f "$tmp_file" ]; then
      rm -f "$tmp_file"
    fi
  done
}
trap cleanup_tmp_files EXIT

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf '[release] comando ausente: %s\n' "$1" >&2
    exit 1
  fi
}

to_bool() {
  local value
  value="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  case "$value" in
    1|true|yes|on)
      printf 'true'
      ;;
    *)
      printf 'false'
      ;;
  esac
}

sanitize_npm_output() {
  printf '%s' "$1" | tr -d "\"'[:space:]"
}

resolve_branch() {
  if [ -n "$RELEASE_GIT_BRANCH" ]; then
    printf '%s' "$RELEASE_GIT_BRANCH"
    return 0
  fi

  local branch=""
  branch="$(cd "$PROJECT_ROOT" && git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  if [ -z "$branch" ]; then
    branch="$(cd "$PROJECT_ROOT" && git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  fi
  if [ "$branch" = "HEAD" ]; then
    branch=""
  fi
  printf '%s' "$branch"
}

resolve_token_from_dotenv() {
  local token_keys="$1"
  if [ -z "$token_keys" ]; then
    return 0
  fi

  (
    cd "$PROJECT_ROOT" && TOKEN_KEYS="$token_keys" node --input-type=module -e "
      import dotenv from 'dotenv';
      dotenv.config({ path: '.env' });
      const keys = String(process.env.TOKEN_KEYS || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      for (const key of keys) {
        const value = process.env[key];
        if (value && String(value).trim()) {
          process.stdout.write(String(value).trim());
          process.exit(0);
        }
      }
    " 2>/dev/null || true
  )
}

create_npmrc_for_registry() {
  local registry="$1"
  local token="$2"
  local scope_owner="$3"
  local registry_host=""
  registry_host="$(printf '%s' "$registry" | sed -E 's#^https?://##; s#/*$##')"

  local npmrc_tmp=""
  npmrc_tmp="$(mktemp /tmp/omnizap-release-npmrc.XXXXXX)"
  {
    printf 'registry=%s\n' "$registry"
    if [ -n "$scope_owner" ]; then
      printf '@%s:registry=%s\n' "$scope_owner" "$registry"
    fi
    if [ -n "$token" ]; then
      printf '//%s/:_authToken=%s\n' "$registry_host" "$token"
      printf '//%s:_authToken=%s\n' "$registry_host" "$token"
    fi
  } > "$npmrc_tmp"
  chmod 600 "$npmrc_tmp"
  TMP_NPMRC_FILES+=("$npmrc_tmp")
  printf '%s' "$npmrc_tmp"
}

verify_registry_version() {
  local pkg_name="$1"
  local pkg_version="$2"
  local registry="$3"
  local token_keys="$4"
  local auth_required="$5"

  local token=""
  token="$(resolve_token_from_dotenv "$token_keys")"
  if [ "$auth_required" = "1" ] && [ -z "$token" ]; then
    printf '[release] Verificação em %s requer token (keys: %s).\n' "$registry" "$token_keys" >&2
    exit 1
  fi

  local scope_owner=""
  scope_owner="$(printf '%s' "$pkg_name" | sed -nE 's#^@([^/]+)/.*#\1#p')"
  local npmrc_tmp=""
  npmrc_tmp="$(create_npmrc_for_registry "$registry" "$token" "$scope_owner")"

  local max_attempts="$RELEASE_VERIFY_MAX_ATTEMPTS"
  if ! [[ "$max_attempts" =~ ^[0-9]+$ ]] || [ "$max_attempts" -lt 1 ]; then
    max_attempts=1
  fi
  local retry_delay="$RELEASE_VERIFY_RETRY_DELAY_SECONDS"
  if ! [[ "$retry_delay" =~ ^[0-9]+$ ]] || [ "$retry_delay" -lt 1 ]; then
    retry_delay=10
  fi

  local version_raw=""
  local version_value=""
  local attempt=1
  while [ "$attempt" -le "$max_attempts" ]; do
    if version_raw="$(
      cd "$PROJECT_ROOT" &&
      npm_config_userconfig="$npmrc_tmp" npm view "${pkg_name}@${pkg_version}" version --registry "$registry" --userconfig "$npmrc_tmp" 2>/dev/null
    )"; then
      version_value="$(sanitize_npm_output "$version_raw")"
      if [ "$version_value" = "$pkg_version" ]; then
        break
      fi
    else
      version_value=""
    fi

    if [ "$attempt" -ge "$max_attempts" ]; then
      printf '[release] Falha ao validar versão %s em %s após %s tentativa(s).\n' "$pkg_version" "$registry" "$max_attempts" >&2
      printf '[release] Último valor encontrado: %s\n' "${version_value:-vazio}" >&2
      exit 1
    fi

    log "Aguardando propagação da versão ${pkg_version} em ${registry} (tentativa ${attempt}/${max_attempts})"
    sleep "$retry_delay"
    attempt=$((attempt + 1))
  done

  local latest_raw=""
  local latest_value=""
  attempt=1
  while [ "$attempt" -le "$max_attempts" ]; do
    if latest_raw="$(
      cd "$PROJECT_ROOT" &&
      npm_config_userconfig="$npmrc_tmp" npm view "$pkg_name" dist-tags.latest --registry "$registry" --userconfig "$npmrc_tmp" 2>/dev/null
    )"; then
      latest_value="$(sanitize_npm_output "$latest_raw")"
      if [ "$latest_value" = "$pkg_version" ]; then
        break
      fi
    else
      latest_value=""
    fi

    if [ "$attempt" -ge "$max_attempts" ]; then
      printf '[release] Dist-tag latest divergente em %s após %s tentativa(s): esperado=%s latest=%s\n' "$registry" "$max_attempts" "$pkg_version" "${latest_value:-vazio}" >&2
      exit 1
    fi

    log "Aguardando atualização da dist-tag latest em ${registry} (tentativa ${attempt}/${max_attempts})"
    sleep "$retry_delay"
    attempt=$((attempt + 1))
  done

  log "Verificado em $registry: versão=$pkg_version latest=$latest_value"
}

compute_target_version() {
  local current="$1"

  if [ -n "$RELEASE_FORCE_VERSION" ]; then
    printf '%s' "$RELEASE_FORCE_VERSION"
    return 0
  fi

  if [ "$RELEASE_TYPE" = "patch" ] && [ "$RELEASE_PATCH_ROLLOVER_ENABLED" = "1" ]; then
    if [[ "$RELEASE_PATCH_ROLLOVER_AT" =~ ^[0-9]+$ ]] && [[ "$current" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
      local major="${BASH_REMATCH[1]}"
      local minor="${BASH_REMATCH[2]}"
      local patch="${BASH_REMATCH[3]}"
      if [ "$patch" -ge "$RELEASE_PATCH_ROLLOVER_AT" ]; then
        printf '%s.%s.0' "$major" "$((minor + 1))"
        return 0
      fi
    fi
  fi

  printf ''
}

resolve_previous_release_tag() {
  local current_tag="$1"
  (
    cd "$PROJECT_ROOT" &&
    git tag --list "${RELEASE_GITHUB_TAG_PREFIX}[0-9]*" --sort=-version:refname |
      grep -Fvx "$current_tag" |
      head -n 1
  )
}

build_release_body_file() {
  local current_tag="$1"
  local target_ref="$2"
  local body_file=""
  body_file="$(mktemp /tmp/omnizap-release-body.XXXXXX.md)"
  TMP_MISC_FILES+=("$body_file")

  local previous_tag=""
  previous_tag="$(resolve_previous_release_tag "$current_tag")"

  local max_files=300
  if [[ "$RELEASE_GITHUB_RELEASE_MAX_FILES" =~ ^[0-9]+$ ]] && [ "$RELEASE_GITHUB_RELEASE_MAX_FILES" -gt 0 ]; then
    max_files="$RELEASE_GITHUB_RELEASE_MAX_FILES"
  fi

  local -a changed_files=()
  if [ -n "$previous_tag" ]; then
    mapfile -t changed_files < <(
      cd "$PROJECT_ROOT" &&
      git diff --name-only --diff-filter=ACMRTUXB "${previous_tag}..${target_ref}" |
        sed '/^$/d'
    )
  fi

  {
    printf '## Arquivos alterados\n\n'
    if [ -n "$previous_tag" ]; then
      printf 'Comparação: `%s...%s`\n\n' "$previous_tag" "$current_tag"
    else
      printf 'Release inicial (sem tag anterior para comparação).\n\n'
    fi

    if [ "${#changed_files[@]}" -eq 0 ]; then
      printf -- '- Nenhum arquivo alterado detectado.\n'
    else
      local total="${#changed_files[@]}"
      local limit="$total"
      if [ "$total" -gt "$max_files" ]; then
        limit="$max_files"
      fi

      local i=0
      while [ "$i" -lt "$limit" ]; do
        printf -- '- `%s`\n' "${changed_files[$i]}"
        i=$((i + 1))
      done

      if [ "$total" -gt "$max_files" ]; then
        printf '\n_...e mais %s arquivo(s)._\n' "$((total - max_files))"
      fi
    fi
  } > "$body_file"

  printf '%s' "$body_file"
}

ensure_release_tag() {
  local tag_name="$1"
  local target_ref="$2"

  local local_target_sha=""
  local_target_sha="$(cd "$PROJECT_ROOT" && git rev-parse "${target_ref}^{}")"

  if (cd "$PROJECT_ROOT" && git rev-parse --verify "refs/tags/${tag_name}" >/dev/null 2>&1); then
    local local_tag_sha=""
    local_tag_sha="$(cd "$PROJECT_ROOT" && git rev-parse "${tag_name}^{}")"
    if [ "$local_tag_sha" != "$local_target_sha" ]; then
      printf '[release] Tag %s já existe e aponta para outro commit (%s).\n' "$tag_name" "$local_tag_sha" >&2
      exit 1
    fi
    log "Tag ${tag_name} já existe localmente."
  else
    if [ "$RELEASE_GIT_TAG_CREATE" != "1" ]; then
      printf '[release] Tag %s não existe e RELEASE_GIT_TAG_CREATE=0.\n' "$tag_name" >&2
      exit 1
    fi
    log "Criando tag ${tag_name}"
    if [ "$RELEASE_GIT_TAG_ANNOTATED" = "1" ]; then
      (cd "$PROJECT_ROOT" && git tag -a "$tag_name" -m "Release ${tag_name}" "$target_ref")
    else
      (cd "$PROJECT_ROOT" && git tag "$tag_name" "$target_ref")
    fi
  fi

  if [ "$RELEASE_GIT_TAG_PUSH" = "1" ]; then
    local remote_sha=""
    remote_sha="$(cd "$PROJECT_ROOT" && git ls-remote --tags "$RELEASE_GIT_REMOTE" "refs/tags/${tag_name}^{}" | awk 'NR==1{print $1}')"
    if [ -z "$remote_sha" ]; then
      remote_sha="$(cd "$PROJECT_ROOT" && git ls-remote --tags "$RELEASE_GIT_REMOTE" "refs/tags/${tag_name}" | awk 'NR==1{print $1}')"
    fi

    if [ -z "$remote_sha" ]; then
      log "Enviando tag ${tag_name} para ${RELEASE_GIT_REMOTE}"
      (cd "$PROJECT_ROOT" && git push "$RELEASE_GIT_REMOTE" "refs/tags/${tag_name}")
    elif [ "$remote_sha" != "$local_target_sha" ]; then
      printf '[release] Tag remota %s já existe e aponta para outro commit (%s).\n' "$tag_name" "$remote_sha" >&2
      exit 1
    else
      log "Tag ${tag_name} já existe no remoto ${RELEASE_GIT_REMOTE}."
    fi
  fi
}

commit_and_push_if_dirty() {
  local commit_message="$1"

  if [ "$RELEASE_GIT_AUTO_COMMIT" != "1" ]; then
    return 0
  fi

  local git_status=""
  git_status="$(cd "$PROJECT_ROOT" && git status --porcelain --untracked-files=normal)"
  if [ -z "$git_status" ]; then
    return 0
  fi

  log "Alterações não commitadas detectadas. Criando commit automático."
  (
    cd "$PROJECT_ROOT"
    git add -A
    if git diff --cached --quiet; then
      exit 0
    fi
    git commit -m "$commit_message" >/dev/null
  )

  if [ "$RELEASE_GIT_AUTO_PUSH" = "1" ]; then
    local branch=""
    branch="$(resolve_branch)"
    if [ -z "$branch" ]; then
      printf '[release] Branch atual indefinida (detached HEAD). Defina RELEASE_GIT_BRANCH para push automático.\n' >&2
      exit 1
    fi
    log "Enviando commit para $RELEASE_GIT_REMOTE/$branch"
    (cd "$PROJECT_ROOT" && git push "$RELEASE_GIT_REMOTE" "$branch")
  fi
}

require_cmd git
require_cmd npm
require_cmd node

if ! (cd "$PROJECT_ROOT" && git rev-parse --is-inside-work-tree >/dev/null 2>&1); then
  printf '[release] este diretório não é um repositório git válido.\n' >&2
  exit 1
fi

if [ "$RELEASE_REQUIRE_GITHUB_RELEASE" = "1" ] && [ "$RELEASE_GITHUB_RELEASE" != "1" ]; then
  printf '[release] RELEASE_REQUIRE_GITHUB_RELEASE=1 exige RELEASE_GITHUB_RELEASE=1.\n' >&2
  exit 1
fi

commit_and_push_if_dirty "$RELEASE_GIT_PRE_COMMIT_MESSAGE"

current_version="$(cd "$PROJECT_ROOT" && npm pkg get version | tr -d '"[:space:]')"
log "Versão atual: $current_version"
target_version="$(compute_target_version "$current_version")"

if [ -n "$target_version" ]; then
  if [ "$target_version" = "$current_version" ]; then
    printf '[release] versão alvo igual à versão atual (%s). Verifique regras de bump.\n' "$current_version" >&2
    exit 1
  fi
  log "Aplicando versão alvo: $target_version"
  (cd "$PROJECT_ROOT" && npm version "$target_version" --no-git-tag-version >/dev/null)
else
  log "Aplicando bump: $RELEASE_TYPE"
  (cd "$PROJECT_ROOT" && npm version "$RELEASE_TYPE" --no-git-tag-version >/dev/null)
fi

new_version="$(cd "$PROJECT_ROOT" && npm pkg get version | tr -d '"[:space:]')"
log "Nova versão: $new_version"

log "Executando deploy com publish de package"
deploy_publish_primary="${DEPLOY_PACKAGE_PUBLISH:-1}"
deploy_publish_secondary="${DEPLOY_PACKAGE_PUBLISH_SECONDARY:-1}"

if [ "$RELEASE_REQUIRE_DUAL_PUBLISH" = "1" ]; then
  if [ "$deploy_publish_primary" != "1" ] || [ "$deploy_publish_secondary" != "1" ]; then
    printf '[release] RELEASE_REQUIRE_DUAL_PUBLISH=1 exige DEPLOY_PACKAGE_PUBLISH=1 e DEPLOY_PACKAGE_PUBLISH_SECONDARY=1.\n' >&2
    exit 1
  fi
fi

if ! (
  cd "$PROJECT_ROOT"
  DEPLOY_PACKAGE_STEP="${DEPLOY_PACKAGE_STEP:-1}" \
  DEPLOY_PACKAGE_PUBLISH="$deploy_publish_primary" \
  DEPLOY_PACKAGE_PUBLISH_SECONDARY="$deploy_publish_secondary" \
  DEPLOY_PACKAGE_SECONDARY_REGISTRY="${DEPLOY_PACKAGE_SECONDARY_REGISTRY:-https://registry.npmjs.org}" \
  DEPLOY_PACKAGE_SECONDARY_ACCESS="${DEPLOY_PACKAGE_SECONDARY_ACCESS:-public}" \
  DEPLOY_PACKAGE_INSTALL="${DEPLOY_PACKAGE_INSTALL:-0}" \
  DEPLOY_PACKAGE_TEST="${DEPLOY_PACKAGE_TEST:-0}" \
  DEPLOY_PACKAGE_PACK="${DEPLOY_PACKAGE_PACK:-1}" \
  npm run deploy
); then
  log "Deploy/release falhou. Revertendo versão para $current_version"
  (cd "$PROJECT_ROOT" && npm version "$current_version" --no-git-tag-version >/dev/null)
  exit 1
fi

if [ "$RELEASE_WIKI_SYNC" = "1" ]; then
  log "Sincronizando wiki do GitHub"
  if ! (
    cd "$PROJECT_ROOT" &&
    WIKI_SYNC_RELEASE_VERSION="$new_version" bash -lc "$RELEASE_WIKI_SYNC_COMMAND"
  ); then
    if [ "$RELEASE_WIKI_SYNC_REQUIRED" = "1" ]; then
      printf '[release] Falha ao sincronizar wiki e RELEASE_WIKI_SYNC_REQUIRED=1.\n' >&2
      exit 1
    fi
    log "Falha ao sincronizar wiki. Continuando release (RELEASE_WIKI_SYNC_REQUIRED=0)."
  fi
fi

if [ "$RELEASE_GIT_COMMIT_VERSION" = "1" ]; then
  commit_and_push_if_dirty "${RELEASE_GIT_VERSION_COMMIT_PREFIX}${new_version}"
fi

release_tag="${RELEASE_GITHUB_TAG_PREFIX}${new_version}"
release_target_ref="$(cd "$PROJECT_ROOT" && git rev-parse HEAD)"

if [ -n "$(cd "$PROJECT_ROOT" && git status --porcelain --untracked-files=no)" ]; then
  printf '[release] Working tree com alterações rastreadas antes de criar tag/release. Ajuste RELEASE_GIT_COMMIT_VERSION ou commite manualmente.\n' >&2
  exit 1
fi

ensure_release_tag "$release_tag" "$release_target_ref"

if [ "$RELEASE_GITHUB_RELEASE" = "1" ]; then
  if [ "$RELEASE_GIT_AUTO_PUSH" != "1" ]; then
    printf '[release] RELEASE_GITHUB_RELEASE=1 requer RELEASE_GIT_AUTO_PUSH=1 para garantir commit acessível no GitHub.\n' >&2
    exit 1
  fi

  local_name="${RELEASE_GITHUB_NAME_PREFIX}${new_version}"
  local_target="$RELEASE_GITHUB_TARGET"
  if [ -z "$local_target" ]; then
    local_target="$release_target_ref"
  fi

  local_prerelease="$RELEASE_GITHUB_PRERELEASE"
  if [ -z "$local_prerelease" ]; then
    if printf '%s' "$new_version" | grep -q '-'; then
      local_prerelease="1"
    else
      local_prerelease="0"
    fi
  fi

  generate_notes_bool=""
  generate_notes_bool="$(to_bool "$RELEASE_GITHUB_GENERATE_NOTES")"
  prerelease_bool=""
  prerelease_bool="$(to_bool "$local_prerelease")"
  draft_bool=""
  draft_bool="$(to_bool "$RELEASE_GITHUB_DRAFT")"
  latest_bool=""
  latest_bool="$(to_bool "$RELEASE_GITHUB_LATEST")"
  release_body_file=""
  if [ "$RELEASE_GITHUB_RELEASE_INCLUDE_CHANGED_FILES" = "1" ]; then
    release_body_file="$(build_release_body_file "$release_tag" "$release_target_ref")"
  fi

  log "Criando/atualizando GitHub Release ($release_tag)"
  if [ -n "$release_body_file" ]; then
    release_output="$(
      cd "$PROJECT_ROOT" && node ./scripts/github-release-notify.mjs upsert \
        --tag "$release_tag" \
        --target "$local_target" \
        --name "$local_name" \
        --generate-notes "$generate_notes_bool" \
        --prerelease "$prerelease_bool" \
        --draft "$draft_bool" \
        --latest "$latest_bool" \
        --body-stdin "true" < "$release_body_file"
    )"
  else
    release_output="$(
      cd "$PROJECT_ROOT" && node ./scripts/github-release-notify.mjs upsert \
        --tag "$release_tag" \
        --target "$local_target" \
        --name "$local_name" \
        --generate-notes "$generate_notes_bool" \
        --prerelease "$prerelease_bool" \
        --draft "$draft_bool" \
        --latest "$latest_bool"
    )"
  fi
  log "GitHub Release atualizado: $release_output"
fi

if [ "$RELEASE_VERIFY_UNIFIED_VERSION" = "1" ]; then
  pkg_name="$(cd "$PROJECT_ROOT" && npm pkg get name | tr -d '"[:space:]')"
  if [ -z "$pkg_name" ]; then
    printf '[release] Falha ao ler nome do pacote para verificação final.\n' >&2
    exit 1
  fi

  local_version_now="$(cd "$PROJECT_ROOT" && npm pkg get version | tr -d '"[:space:]')"
  if [ "$local_version_now" != "$new_version" ]; then
    printf '[release] Versão local divergente após release: esperado=%s encontrado=%s\n' "$new_version" "$local_version_now" >&2
    exit 1
  fi
  log "Verificado localmente: versão=$local_version_now"

  tag_commit_now="$(cd "$PROJECT_ROOT" && git rev-parse "${release_tag}^{}" 2>/dev/null || true)"
  if [ -z "$tag_commit_now" ]; then
    printf '[release] Tag local ausente: %s\n' "$release_tag" >&2
    exit 1
  fi
  if [ "$tag_commit_now" != "$release_target_ref" ]; then
    printf '[release] Tag local %s aponta para commit divergente (%s).\n' "$release_tag" "$tag_commit_now" >&2
    exit 1
  fi
  log "Verificada tag local: ${release_tag} -> ${tag_commit_now}"

  if [ "$RELEASE_GIT_TAG_PUSH" = "1" ]; then
    remote_tag_sha="$(cd "$PROJECT_ROOT" && git ls-remote --tags "$RELEASE_GIT_REMOTE" "refs/tags/${release_tag}^{}" | awk 'NR==1{print $1}')"
    if [ -z "$remote_tag_sha" ]; then
      remote_tag_sha="$(cd "$PROJECT_ROOT" && git ls-remote --tags "$RELEASE_GIT_REMOTE" "refs/tags/${release_tag}" | awk 'NR==1{print $1}')"
    fi
    if [ -z "$remote_tag_sha" ]; then
      printf '[release] Tag remota ausente: %s em %s\n' "$release_tag" "$RELEASE_GIT_REMOTE" >&2
      exit 1
    fi
    if [ "$remote_tag_sha" != "$release_target_ref" ]; then
      printf '[release] Tag remota %s divergente (%s).\n' "$release_tag" "$remote_tag_sha" >&2
      exit 1
    fi
    log "Verificada tag remota: ${release_tag} -> ${remote_tag_sha}"
  fi

  verify_registry_version "$pkg_name" "$new_version" "$RELEASE_VERIFY_PRIMARY_REGISTRY" "$RELEASE_VERIFY_PRIMARY_TOKEN_KEYS" "1"
  verify_registry_version "$pkg_name" "$new_version" "$RELEASE_VERIFY_SECONDARY_REGISTRY" "$RELEASE_VERIFY_SECONDARY_TOKEN_KEYS" "0"

  gh_release_check="$(
    cd "$PROJECT_ROOT" && node ./scripts/github-release-notify.mjs get --tag "$release_tag"
  )"
  log "Verificado GitHub Release: $gh_release_check"
  log "Verificação final concluída: todas as versões estão em $new_version"
fi

log "Release concluída: $new_version"
