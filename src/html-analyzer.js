import { URL } from 'node:url';

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

  // Ces valeurs ne constituent pas des liens éditoriaux utiles à cet audit.
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
export function analyzeHtml(bodyBuffer, pageUrl) {
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
