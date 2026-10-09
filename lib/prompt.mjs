/**
 * The red-team prompt contract, served as a dynamic system-prompt section.
 *
 * DSH 2.0 replacement for the 0.1-era "activation message": instead of faking
 * a durable user message on every mode switch, the contract is registered once
 * as a prompt section whose text is evaluated per assembly. In `normal` mode it
 * renders empty, and an empty section disappears from the prompt — so ordinary
 * development turns stay byte-identical to a plugin-free harness.
 */
import { buildAuthorizationContext, buildRuntimeNotice } from './controller.mjs'
import { loadModeContract, loadProfileContent } from './profiles.mjs'

export const MODE_SECTION_NAME = 'redteam:mode-contract'
/**
 * Placed after every first-party section (identity 10000/10100/10200) so the
 * mode contract reads as deployment policy rather than as harness identity.
 */
export const MODE_SECTION_ORDER = 12000

export function isActiveMode(mode) {
  return mode === 'redteam-light' || mode === 'redteam-full'
}

/**
 * Build the prompt section text for one state snapshot.
 * @returns the contract, or `''` when the mode is inactive.
 */
export function modeSectionText(state, options = {}) {
  const mode = state?.mode ?? 'normal'
  if (!isActiveMode(mode)) return ''
  const route = options.route ?? {}
  const profile = options.injectProfileOnActivation === false
    ? { profile: '', filename: '', content: '' }
    : loadProfileContent(route.model ?? '')
  return [
    `[redteam-mode] ACTIVE (${mode}); OPSEC=${state.opsec_level || 'balanced'}.`,
    options.injectAuthorizationContext === false ? '' : buildAuthorizationContext(mode),
    loadModeContract(),
    profile.content
      ? `[model-prompt-profile]\nmodel=${route.model ?? 'unknown'}; profile=${profile.profile}; file=${profile.filename}; scope=session; authoritative=true\n${profile.content}`
      : '',
    buildRuntimeNotice(state),
  ].filter(Boolean).join('\n\n')
}
