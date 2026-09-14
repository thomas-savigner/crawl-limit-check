#!/usr/bin/env node

/**
 * Audit simple de la limite de téléchargement HTML de Googlebot.
 *
 * Les offsets affichés sont relatifs au début du BODY brut et sont exprimés
 * en octets. La requête force `Accept-Encoding: identity` et Node ne
 * décompresse jamais automatiquement la réponse.
 */

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

const GOOGLEBOT_LIMIT = 2_097_152; // 2 Mio
const ONE_MIB = 1_048_576;
const WARNING_RATIO = 0.8;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 1;

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

/**
 * Prépare les headers pour leur prise en compte dans le budget de 2 Mio.
 *
 * Node expose les noms et valeurs reçus via rawHeaders, mais pas les octets
 * exacts de la section headers. On reconstruit donc une réponse HTTP/1.x
 * standard : ligne de statut + headers + ligne vide finale.
 */
function serializeResponseHeaders(response) {
  const statusLine =
    `HTTP/${response.httpVersion} ${response.statusCode}` +
    `${response.statusMessage ? ` ${response.statusMessage}` : ''}\r\n`;

  let serialized = statusLine;

  for (let i = 0; i < response.rawHeaders.length; i += 2) {
    serialized += `${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}\r\n`;
  }

  return Buffer.from(`${serialized}\r\n`, 'latin1');
}

/**
 * Télécharge une URL sans compression et rassemble les métadonnées HTTP ainsi
 * que le body brut nécessaires aux étapes de mesure et d'analyse.
 */
function requestOnce(url) {
  const transport = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const request = transport.get(
      url,
      {
        headers: {
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
          'Accept-Encoding': 'identity',
          'User-Agent': 'googlebot-2mb-audit/1.0',
        },
      },
      (response) => {
        const chunks = [];

        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            url,
            statusCode: response.statusCode ?? 0,
            statusMessage: response.statusMessage ?? '',
            headers: response.headers,
            rawHeaders: response.rawHeaders,
            headerBuffer: serializeResponseHeaders(response),
            bodyBuffer: Buffer.concat(chunks),
          });
        });
        response.on('error', reject);
      },
    );

    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(
        new Error(`Délai dépassé après ${REQUEST_TIMEOUT_MS / 1000} secondes.`),
      );
    });

    request.on('error', reject);
  });
}

/** Suit au maximum une redirection avant de remettre la réponse à l'audit. */
async function fetchWithRedirect(initialUrl) {
  const redirects = [];
  let currentUrl = initialUrl;

  for (let followed = 0; followed <= MAX_REDIRECTS; followed += 1) {
    const response = await requestOnce(currentUrl);
    const isRedirect = response.statusCode >= 300 && response.statusCode < 400;
    const location = response.headers.location;

    if (!isRedirect || !location) {
      return { response, redirects };
    }

    let nextUrl;
    try {
      nextUrl = new URL(location, currentUrl);
    } catch {
      throw new Error(`Redirection invalide reçue : ${location}`);
    }

    if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
      throw new Error(`Protocole de redirection non pris en charge : ${nextUrl.protocol}`);
    }

    redirects.push({
      from: currentUrl.href,
      to: nextUrl.href,
      statusCode: response.statusCode,
    });

    if (followed === MAX_REDIRECTS) {
      return { response, redirects, redirectLimitReached: true };
    }

    currentUrl = nextUrl;
  }

  throw new Error('Erreur interne lors du suivi des redirections.');
}

/** Retourne l'offset de la première occurrence d'un motif dans une plage donnée. */
function firstMatchOffset(source, regex, startOffset = 0, endOffset = source.length) {
  const match = regex.exec(source.slice(startOffset, endOffset));
  return match ? startOffset + match.index : null;
}

/** Extrait la valeur d'un attribut depuis le texte brut d'une balise HTML. */
function getAttribute(tag, attributeName) {
  // Accepte les valeurs entre guillemets simples/doubles et les valeurs nues.
  const pattern = new RegExp(
    `\\b${attributeName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    'i',
  );
  const match = pattern.exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : null;
}

/**
 * Parcourt les balises d'un type donné et retourne la première dont les
 * attributs satisfont le prédicat fourni par l'étape d'analyse.
 */
function findTagByAttributes(source, tagName, predicate, start = 0, end = source.length) {
  const tagPattern = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
  tagPattern.lastIndex = start;

  let match;
  while ((match = tagPattern.exec(source)) !== null) {
    if (match.index >= end) break;
    if (predicate(match[0])) return { offset: match.index, tag: match[0] };
  }

  return null;
}

/** Détermine si un href représente un lien éditorial interne à la page auditée. */
function isInternalHref(href, pageUrl) {
  const value = href.trim();

  // Ces valeurs sont techniquement relatives pour certaines d'entre elles,
  // mais ne constituent pas des liens éditoriaux utiles à cet audit.
  if (
    value === '' ||
    value.startsWith('#') ||
    /^(?:javascript|mailto|tel|data):/i.test(value)
  ) {
    return false;
  }

  try {
    const resolved = new URL(value, pageUrl);
    return (
      (resolved.protocol === 'http:' || resolved.protocol === 'https:') &&
      resolved.hostname.toLowerCase() === pageUrl.hostname.toLowerCase()
    );
  } catch {
    return false;
  }
}

/**
 * Sélectionne le lien interne le plus pertinent : dans <main>, après <h1>,
 * puis n'importe où dans la page en dernier recours.
 */
function findImportantInternalLink(source, pageUrl, h1Offset) {
  const mainOpen = /<main\b[^>]*>/i.exec(source);

  // Priorité 1 : premier lien interne contenu dans <main>.
  if (mainOpen) {
    const mainStart = mainOpen.index + mainOpen[0].length;
    const mainCloseOffset = firstMatchOffset(source, /<\/main\s*>/i, mainStart);
    const mainEnd = mainCloseOffset ?? source.length;
    const inMain = findTagByAttributes(
      source,
      'a',
      (tag) => {
        const href = getAttribute(tag, 'href');
        return href !== null && isInternalHref(href, pageUrl);
      },
      mainStart,
      mainEnd,
    );

    if (inMain) return inMain.offset;
  }

  // Priorité 2 : premier lien interne après le premier <h1>.
  if (h1Offset !== null) {
    const afterH1 = findTagByAttributes(
      source,
      'a',
      (tag) => {
        const href = getAttribute(tag, 'href');
        return href !== null && isInternalHref(href, pageUrl);
      },
      h1Offset,
    );

    if (afterH1) return afterH1.offset;
  }

  // Dernier recours : premier lien interne de la page.
  return (
    findTagByAttributes(source, 'a', (tag) => {
      const href = getAttribute(tag, 'href');
      return href !== null && isInternalHref(href, pageUrl);
    })?.offset ?? null
  );
}

/**
 * Localise dans le body brut les éléments SEO critiques et retourne leurs
 * offsets en octets pour vérifier leur visibilité avant la coupure.
 */
function analyzeHtml(bodyBuffer, pageUrl) {
  /**
   * latin1 établit une correspondance 1:1 entre index JavaScript et octets.
   * Les noms de balises/attributs recherchés sont ASCII : leurs offsets restent
   * donc exacts, y compris avec du texte UTF-8 multioctet avant eux.
   */
  const source = bodyBuffer.toString('latin1');

  const title = firstMatchOffset(source, /<title\b[^>]*>/i);
  const canonical =
    findTagByAttributes(source, 'link', (tag) => {
      const rel = getAttribute(tag, 'rel');
      const href = getAttribute(tag, 'href');
      return (
        href !== null &&
        rel !== null &&
        rel.split(/\s+/).some((token) => token.toLowerCase() === 'canonical')
      );
    })?.offset ?? null;
  const jsonLd =
    findTagByAttributes(source, 'script', (tag) => {
      const type = getAttribute(tag, 'type');
      return type?.trim().toLowerCase() === 'application/ld+json';
    })?.offset ?? null;
  const h1 = firstMatchOffset(source, /<h1\b[^>]*>/i);
  const importantInternalLink = findImportantInternalLink(source, pageUrl, h1);

  return { title, canonical, jsonLd, h1, importantInternalLink };
}

/** Formate une quantité d'octets pour rendre le rapport console lisible. */
function formatBytes(value) {
  return new Intl.NumberFormat('fr-FR').format(value);
}

/** Formate le pourcentage de budget consommé avec une décimale. */
function formatPercent(value) {
  return new Intl.NumberFormat('fr-FR', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value);
}

/**
 * Transforme un offset brut en libellé de rapport et indique s'il se situe
 * avant ou après la limite globale, headers inclus.
 */
function offsetLabel(offset, headerSize) {
  if (offset === null) return 'non trouvé';

  const absolutePosition = headerSize + offset;
  const visibility = absolutePosition < GOOGLEBOT_LIMIT ? 'avant la limite' : 'hors limite';
  return `${formatBytes(offset)} (${visibility})`;
}

/**
 * Calcule les indicateurs finaux, lance l'analyse HTML et affiche le rapport
 * ainsi que les avertissements et le code de sortie destiné à la CI.
 */
function printReport(result) {
  const { response, redirects, redirectLimitReached } = result;
  const headerSize = response.headerBuffer.length;
  const bodySize = response.bodyBuffer.length;
  const totalSize = headerSize + bodySize;
  const budgetRatio = totalSize / GOOGLEBOT_LIMIT;
  const contentType = String(response.headers['content-type'] ?? 'non renseigné');
  const contentEncoding = String(response.headers['content-encoding'] ?? 'identity');
  const isHtml = /(?:text\/html|application\/xhtml\+xml)/i.test(contentType);
  const isIdentity = /^(?:identity)?$/i.test(contentEncoding.trim());

  let status = 'OK';
  if (totalSize > GOOGLEBOT_LIMIT) status = 'DÉPASSÉ';
  else if (budgetRatio >= WARNING_RATIO) status = 'ATTENTION';

  let risk = 'faible';
  if (totalSize > GOOGLEBOT_LIMIT) risk = 'élevé';
  else if (budgetRatio >= WARNING_RATIO) risk = 'moyen';

  console.log(`URL demandée : ${redirects[0]?.from ?? response.url.href}`);
  console.log(`URL finale : ${response.url.href}`);
  console.log(`Statut HTTP : ${response.statusCode} ${response.statusMessage}`.trimEnd());
  console.log(`Content-Type : ${contentType}`);
  console.log(`Content-Encoding : ${contentEncoding}`);
  console.log(`Taille headers (estimée) : ${formatBytes(headerSize)} octets`);
  console.log(`Taille body : ${formatBytes(bodySize)} octets`);
  console.log(`Taille totale : ${formatBytes(totalSize)} octets`);
  console.log(`Limite Googlebot : ${formatBytes(GOOGLEBOT_LIMIT)} octets`);
  console.log(`Statut : ${status}`);

  if (redirects.length > 0) {
    console.log('\nRedirections :');
    for (const redirect of redirects) {
      console.log(`- ${redirect.statusCode} : ${redirect.from} -> ${redirect.to}`);
    }
  }

  const warnings = [];
  if (response.statusCode !== 200) {
    warnings.push(`la réponse finale n'est pas HTTP 200 (${response.statusCode})`);
  }
  if (redirectLimitReached) {
    warnings.push(`plus de ${MAX_REDIRECTS} redirection : audit arrêté sur cette réponse`);
  }
  if (!isHtml) {
    warnings.push(`contenu non HTML d'après Content-Type (${contentType})`);
  }
  if (!isIdentity) {
    warnings.push(
      `le serveur a ignoré Accept-Encoding: identity (${contentEncoding}) ; ` +
        'le body reste compressé et les offsets HTML ne sont pas calculables',
    );
  }

  let offsets = null;
  if (isHtml && isIdentity) {
    offsets = analyzeHtml(response.bodyBuffer, response.url);
    console.log('\nOffsets (dans le body brut, en octets) :');
    console.log(`- <title> : ${offsetLabel(offsets.title, headerSize)}`);
    console.log(`- canonical : ${offsetLabel(offsets.canonical, headerSize)}`);
    console.log(`- JSON-LD (schema) : ${offsetLabel(offsets.jsonLd, headerSize)}`);
    console.log(`- premier <h1> : ${offsetLabel(offsets.h1, headerSize)}`);
    console.log(
      `- premier lien interne important : ` +
        offsetLabel(offsets.importantInternalLink, headerSize),
    );
  }

  console.log('\nAnalyse :');
  if (offsets) {
    const foundOffsets = Object.values(offsets).filter((offset) => offset !== null);
    const missingCount = Object.values(offsets).length - foundOffsets.length;

    if (foundOffsets.length > 0 && foundOffsets.every((offset) => offset < ONE_MIB)) {
      console.log('- Tous les éléments critiques détectés sont avant 1 Mio du body : OK.');
    } else if (foundOffsets.length > 0) {
      console.log("- Au moins un élément critique détecté apparaît après 1 Mio du body.");
    } else {
      console.log("- Aucun des éléments critiques recherchés n'a été détecté.");
    }

    if (missingCount > 0) {
      console.log(`- ${missingCount} élément(s) critique(s) non trouvé(s).`);
    }

    const outsideLimit = foundOffsets.filter(
      (offset) => headerSize + offset >= GOOGLEBOT_LIMIT,
    ).length;
    if (outsideLimit > 0) {
      console.log(`- ${outsideLimit} élément(s) détecté(s) commencent hors du budget Googlebot.`);
    }
  }

  console.log(`- La réponse utilise ${formatPercent(budgetRatio * 100)} % du budget de 2 Mio.`);
  console.log(`- Risque de troncature : ${risk}.`);

  if (warnings.length > 0) {
    console.log('\nAvertissements :');
    for (const warning of warnings) console.log(`- ${warning}.`);
  }

  // Un statut non-200 reste un résultat auditable, mais doit être visible en CI.
  if (response.statusCode !== 200 || totalSize > GOOGLEBOT_LIMIT || !isHtml) {
    process.exitCode = 2;
  }
}

/** Orchestre le programme : arguments, téléchargement, rapport et erreurs. */
async function main() {
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

await main();
