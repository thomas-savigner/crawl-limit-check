import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

import { MAX_REDIRECTS, REQUEST_TIMEOUT_MS } from './config.js';

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
          'User-Agent': 'crawl-limit-check/1.0',
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
export async function fetchWithRedirect(initialUrl) {
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
