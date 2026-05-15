/**
 * Client identification headers stamped on every Daguito SDK request.
 *
 * SDK_VERSION is the source of truth for the published version. It must stay
 * in sync with `package.json` `version`. We keep it as a TS const (not a
 * `package.json` JSON import) so React Native bundlers and CJS/ESM targets
 * all consume the same value without runtime resolution.
 */

export const SDK_LANG = 'js'
export const SDK_VERSION = '0.3.0'

export function clientHeaders(): Record<string, string> {
  return {
    'X-Daguito-Client': `daguito-sdk-js/${SDK_VERSION}`,
    'X-Daguito-Client-Lang': SDK_LANG,
    'X-Daguito-Client-Version': SDK_VERSION,
  }
}

export function clientQueryParams(): Record<string, string> {
  return {
    x_daguito_client_lang: SDK_LANG,
    x_daguito_client_version: SDK_VERSION,
  }
}

export function appendClientQueryParams(url: string): string {
  const sep = url.includes('?') ? '&' : '?'
  const qs = Object.entries(clientQueryParams())
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&')
  return `${url}${sep}${qs}`
}
