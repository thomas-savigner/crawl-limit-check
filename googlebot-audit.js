#!/usr/bin/env node

/**
 * Point d'entrée du CLI.
 *
 * Toute la logique métier vit dans `src/` afin que ce fichier indique
 * immédiatement où commence l'exécution, sans mélanger les responsabilités.
 */

import { runCli } from './src/cli.js';

await runCli();
