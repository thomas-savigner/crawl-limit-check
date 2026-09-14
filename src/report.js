import { GOOGLEBOT_LIMIT, MAX_REDIRECTS, ONE_MIB, WARNING_RATIO } from './config.js';
import { analyzeHtml } from './html-analyzer.js';

const OFFSET_BAR_WIDTH = 40;
const OFFSET_LABEL_WIDTH = 15;

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
 * Construit une jauge CLI représentant la position totale d'un élément SEO
 * dans le budget Googlebot, en tenant compte de la taille des headers.
 */
function buildOffsetBar(offset, headerSize) {
  if (offset === null) {
    return `[${'?'.repeat(OFFSET_BAR_WIDTH)}] non trouvé`;
  }

  const ratio = (headerSize + offset) / GOOGLEBOT_LIMIT;
  const bar = Array(OFFSET_BAR_WIDTH).fill('─');

  if (ratio >= 1) {
    // Le chevron placé sur le bord droit montre que l'élément dépasse la jauge.
    bar[OFFSET_BAR_WIDTH - 1] = '>';
  } else {
    const markerIndex = Math.min(
      OFFSET_BAR_WIDTH - 1,
      Math.floor(ratio * OFFSET_BAR_WIDTH),
    );
    bar[markerIndex] = '●';
  }

  return `[${bar.join('')}] ${formatPercent(ratio * 100)} %`;
}

/** Affiche les offsets SEO sous forme de jauges alignées de 0 à 2 Mio. */
function printOffsetsVisualization(offsets, headerSize) {
  const rows = [
    ['<title>', offsets.title],
    ['canonical', offsets.canonical],
    ['JSON-LD', offsets.jsonLd],
    ['<h1>', offsets.h1],
    ['lien interne', offsets.importantInternalLink],
  ];
  const axisSpacing = ' '.repeat(OFFSET_BAR_WIDTH - 8);

  console.log('\nVue visuelle (position headers + body / limite Googlebot) :');
  console.log(`${' '.repeat(OFFSET_LABEL_WIDTH + 4)}0 %${axisSpacing}100 %`);

  for (const [label, offset] of rows) {
    console.log(
      `- ${label.padEnd(OFFSET_LABEL_WIDTH)} ${buildOffsetBar(offset, headerSize)}`,
    );
  }

  console.log('  Légende : ● avant la limite | > hors limite | ? non trouvé');
}

/**
 * Calcule les indicateurs finaux, lance l'analyse HTML et affiche le rapport
 * ainsi que les avertissements et le code de sortie destiné à la CI.
 */
export function printReport(result) {
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
    printOffsetsVisualization(offsets, headerSize);
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
