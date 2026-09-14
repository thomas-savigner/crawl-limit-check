import { URL } from 'node:url';

import { fetchWithRedirect } from './http-client.js';
import { printReport } from './report.js';

/** Affiche la syntaxe attendue lorsque les arguments CLI sont incorrects. */
function usage() {
  console.error('Usage : node googlebot-audit.js <URL>');
  console.error('Exemple : node googlebot-audit.js https://exemple.com/page');
}

/** Valide l'argument CLI et le transforme en URL HTTP(S) exploitable. */
function parseTarget(value) {
  let url;

  try {
    url = new URL(value);
  } catch {
    throw new Error(`URL invalide : ${value}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Seuls les protocoles HTTP et HTTPS sont acceptés.');
  }

  return url;
}

/** Orchestre le programme : arguments, téléchargement, rapport et erreurs. */
export async function runCli() {
  const input = process.argv[2];

  if (!input || process.argv.length > 3) {
    usage();
    process.exitCode = 1;
    return;
  }

  try {
    const targetUrl = parseTarget(input);
    const result = await fetchWithRedirect(targetUrl);
    printReport(result);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    console.error(`Erreur : impossible d'auditer l'URL. ${details}`);
    process.exitCode = 1;
  }
}
