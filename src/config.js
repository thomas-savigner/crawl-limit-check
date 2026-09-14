/**
 * Configuration partagée de l'audit.
 *
 * Centraliser ces valeurs permet de modifier le comportement du CLI sans
 * parcourir les modules HTTP, HTML et rapport.
 */

export const GOOGLEBOT_LIMIT = 2_097_152; // 2 Mio
export const ONE_MIB = 1_048_576;
export const WARNING_RATIO = 0.8;
export const REQUEST_TIMEOUT_MS = 15_000;
export const MAX_REDIRECTS = 1;
