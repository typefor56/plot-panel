# Brief — panneau de figures pour VS Code

Tu construis ce projet de bout en bout, en autonomie complète. Le dépôt ne contient qu'un dossier `docs/` avec une capture d'écran, et un commit initial. Tout le reste est à créer par toi, y compris l'outillage et la configuration git.

Ne me pose pas de questions et n'attends aucune validation. Quand une décision est ambiguë, tranche vers l'option la plus simple et la plus robuste, et note le choix dans le `CLAUDE.md`. Je veux revenir sur un projet terminé, testé et committé.

## Le problème

Je fais du machine learning en Python dans VS Code, avec l'Interactive Window et des cellules `# %%`. Il me manque ce que RStudio et Positron ont et que VS Code n'a pas : un panneau de figures permanent.

Le Plot Viewer intégré à l'extension Jupyter est passif. Il faut double-cliquer sur une sortie pour l'ouvrir, il n'offre que des flèches précédent/suivant sans aperçu, et c'est un onglet d'éditeur qui se fait remplacer par le fichier suivant. Quand j'itère sur des hyperparamètres et que je régénère la même courbe vingt fois, je veux voir arriver chaque figure sans rien cliquer, et revenir d'un coup d'œil à celle d'il y a trois essais.

`docs/reference-positron.png` montre la cible. **Sers-t'en uniquement comme référence de disposition** : le suivi des variables en haut à droite, les figures en dessous, une bande de vignettes cliquables en bas du panneau des figures. Tout le reste de la capture est hors sujet — panneau de chat, Quarto, session R, onglets Connections et Help.

## Ce qu'il faut construire

Une extension VS Code qui capture automatiquement les figures produites par les kernels Jupyter et les affiche dans une vue dédiée, plaçable dans la barre latérale secondaire.

Indispensable :

- Capture automatique des sorties image des notebooks **et de l'Interactive Window**, sans action de l'utilisateur.
- Affichage de la figure courante, redimensionnée pour remplir le panneau sans déformation.
- Bande de vignettes de tout l'historique de la session, cliquables pour revenir en arrière.
- Navigation au clavier et par boutons dans la barre de titre de la vue.
- Sauvegarde de la figure courante sur disque, dans son format d'origine.
- Réglages : révélation automatique du panneau à l'arrivée d'une figure, suivi ou non de la dernière figure, plafond d'historique.

Ensuite, une fois la base solide et committée :

- Persistance de l'historique entre les redémarrages, dans le stockage de l'extension. N'utilise pas `workspaceState`, qui n'est pas fait pour des données binaires.
- Vignettes réduites, pour ne pas conserver toutes les figures en pleine résolution ni les transmettre entièrement au webview à chaque rechargement.
- Copie de la figure courante dans le presse-papiers, export de tout l'historique vers un dossier.

## Hors périmètre

- **Ne réimplémente pas le suivi des variables.** L'extension Jupyter fournit déjà une vue Variables, déplaçable dans la barre latérale secondaire. La dupliquer imposerait d'interroger le kernel en boucle avec du code injecté : plus fragile, plus lent, pour un résultat inférieur. Documente simplement dans le README comment la déplacer au-dessus du panneau de figures.
- Pas de fonctionnalité R, pas de Quarto, pas d'intégration IA.

## Contraintes dures

Ce ne sont pas des préférences. En violer une, c'est un échec, pas un compromis.

1. **Zéro dépendance à l'exécution.** Dépendances de développement uniquement : TypeScript, les paquets de types, l'outillage de test et `vsce`. Je veux pouvoir faire relire cette extension par une équipe sécurité en entreprise, et c'est l'arbre de dépendances qui fait échouer ce genre de revue.
2. **Aucun accès réseau, aucune télémétrie.**
3. **API VS Code stable uniquement.** Pas d'API proposée : elles sont inutilisables dans un build installé.
4. **TypeScript strict**, compilation sans erreur ni `any`.
5. **Webview sécurisé** : Content-Security-Policy avec nonce généré à chaque rendu, pas de gestionnaire d'événement en ligne, pas d'`innerHTML` avec des données interpolées.
6. **Style natif** : toutes les couleurs viennent des variables de thème `--vscode-*`. Le panneau doit être indiscernable d'un panneau intégré, en thème clair comme en thème sombre. Aucune couleur en dur.

## Pièges connus

Vérifie chacun de ces points, ne les prends pas pour argent comptant.

- VS Code modélise l'Interactive Window comme un document notebook. C'est probablement la clé pour couvrir les deux cas avec un seul mécanisme, plutôt que de traiter séparément notebooks et console interactive.
- Les événements de changement de sortie de cellule se déclenchent plusieurs fois pour une même exécution. Sans déduplication, l'historique se remplit de doublons. Déduplique sur le contenu, pas sur un identifiant fourni par l'API.
- Un kernel propose souvent plusieurs représentations MIME de la même sortie. Choisis la plus riche, en préférant le vectoriel au bitmap.
- Les sorties interactives qui passent par un widget plutôt que par une image — plotly, bokeh, ipywidgets — n'ont pas d'image statique à récupérer. Le comportement attendu est un message explicite, pas un silence.
- Le réglage `jupyter.generateSVGPlots` change ce que le kernel émet. À mentionner dans le README.

## Livrables

- Squelette complet : `package.json`, `tsconfig.json`, `.gitignore` (au minimum `node_modules/`, `out/`, `*.vsix`), `.vscodeignore`, licence MIT.
- Code source TypeScript, découpé en modules cohérents.
- Un `CLAUDE.md` à la racine, écrit une fois l'architecture stabilisée. Il doit contenir : ce qu'est le projet, la carte des modules et le rôle de chacun, les contraintes dures ci-dessus reformulées comme critères d'échec, les conventions de code adoptées, les décisions que tu as tranchées seul avec leur raison, et les commandes de vérification. C'est le fichier que liront tes prochaines sessions — écris-le pour quelqu'un qui n'a pas ce brief sous les yeux.
- Un `README.md` : ce que fait l'extension, en quoi elle diffère du Plot Viewer intégré, comment la construire, l'installer, la placer dans la barre latérale secondaire à côté de la vue Variables, tableau des réglages, limites connues.
- Des tests avec `@vscode/test-cli` et `@vscode/test-electron`, exécutables par `npm test` sans intervention manuelle. Couvre au minimum la déduplication, l'éviction quand le plafond est atteint, la sélection après éviction, le choix du type MIME quand plusieurs représentations sont proposées, et la persistance sur un aller-retour disque. Les tests tournent dans un vrai hôte d'extension : sers-t'en pour valider le comportement réel, pas seulement la logique pure.
- Un `.vsix` installable produit par `vsce package`, non committé.

## Méthode

Procède par jalons. Chacun se termine par une compilation propre, les tests qui passent, et un commit atomique dont le message explique le pourquoi. N'enchaîne pas plusieurs jalons dans un seul gros changement : je relirai l'historique.

Le commit initial existe déjà, ne réécris pas l'historique.

Si une fonctionnalité s'avère impossible avec l'API stable, ne la contourne pas par une API proposée ni par une façade qui simule le comportement. Retire-la, et documente pourquoi dans une section « Limites connues » du README. Les contraintes dures priment sur l'accomplissement de la tâche.

## Fini quand

- `npm run compile` passe sans erreur ni avertissement.
- `npm test` passe, et les tests exercent réellement la capture de sorties dans un hôte d'extension.
- `npx @vscode/vsce package` produit un `.vsix`.
- L'arbre de dépendances de production est vide — vérifie-le explicitement et écris le résultat dans ton rapport final.
- Le README décrit le comportement réel, pas le comportement souhaité.
- Tout est committé, l'arbre de travail est propre.

Termine par un résumé court : ce qui marche, ce que tu as dû retirer et pourquoi, et le seul test manuel que je dois faire moi-même pour valider de mes yeux.
