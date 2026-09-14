# crawl-limit-check

Ce CLI télécharge une URL sans compression, mesure la réponse et vérifie si les
éléments SEO importants apparaissent avant la limite de 2 Mio.

## Utilisation

```bash
node googlebot-audit.js https://exemple.com/page
```

Ou avec le script npm :

```bash
npm run audit -- https://exemple.com/page
```

## Architecture

```text
.
├── googlebot-audit.js       Point d'entrée minimal du CLI
├── package.json             Configuration ESM et commande npm
└── src
    ├── cli.js               Validation de l'URL et orchestration
    ├── config.js            Limites, timeout et seuils partagés
    ├── http-client.js       Requête HTTP(S), body brut et redirection
    ├── html-analyzer.js     Recherche des éléments SEO et de leurs offsets
    └── report.js            Calculs finaux et affichage dans le terminal
```

## Flux d'exécution

```text
URL passée au CLI
       │
       ▼
Validation de l'URL                  src/cli.js
       │
       ▼
Téléchargement sans compression      src/http-client.js
       │
       ├── headers bruts reconstruits
       ├── body conservé en Buffer
       └── une redirection maximum
       │
       ▼
Analyse des balises SEO              src/html-analyzer.js
       │
       ├── title et canonical
       ├── JSON-LD et premier h1
       └── lien interne important
       │
       ▼
Calcul et rapport console            src/report.js
```

Les modules n'exportent que les fonctions nécessaires au module suivant. Les
petites fonctions techniques restent privées dans leur fichier, ce qui limite
le nombre de concepts à connaître pour comprendre chaque étape.

## Visualisation des offsets

Après les offsets numériques, le rapport affiche une jauge par élément SEO :

```text
                    0 %                                100 %
- <title>         [●───────────────────────────────────────] 0,1 %
- canonical       [────●───────────────────────────────────] 10,4 %
- JSON-LD         [───────────────────────────────────────>] 101,2 %
- <h1>            [????????????????????????????????????????] non trouvé
```

La position combine les headers et l'offset dans le body. `●` signale un
élément placé avant la limite, `>` un élément au-delà des 2 Mio et `?` un
élément absent du HTML analysé.

## Codes de sortie

- `0` : audit terminé sans dépassement ni anomalie majeure ;
- `1` : argument invalide, erreur réseau, DNS ou timeout ;
- `2` : limite dépassée, statut HTTP non-200 ou contenu non HTML.
