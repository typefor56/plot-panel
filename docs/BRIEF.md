# Brief — panneau de figures pour VS Code

> À coller dans Claude Code à la racine du dépôt.

---

Tu démarres un projet à partir de zéro. Le dépôt ne contient qu'un dossier `docs/` avec une capture d'écran, et un commit initial. Tout le reste est à créer.

Explore d'abord, propose un plan, attends ma validation. N'écris pas de code avant.

## Le problème

Je fais du machine learning en Python dans VS Code, avec l'Interactive Window et des cellules `# %%`. Il me manque une chose que RStudio et Positron ont et que VS Code n'a pas : un panneau de figures permanent.

Le Plot Viewer intégré à l'extension Jupyter est passif. Il faut double-cliquer sur une sortie pour l'ouvrir, il ne propose que des flèches précédent/suivant sans aperçu, et c'est un onglet d'éditeur qui se fait remplacer par le fichier suivant. Quand j'itère sur des hyperparamètres et que je régénère la même courbe vingt fois, je veux voir arriver chaque figure sans rien cliquer, et pouvoir revenir d'un coup d'œil à celle d'il y a trois essais.

`docs/reference-positron.png` montre la cible. **Sers-t'en uniquement comme référence de disposition** : le suivi des variables en haut à droite, les figures en dessous, une bande de vignettes cliquables en bas du panneau des figures. Tout le reste de la capture est hors sujet — panneau de chat, Quarto, session R, onglets Connections et Help.

## Ce qu'il faut construire

Une extension VS Code qui capture automatiquement les figures produites par les kernels Jupyter et les affiche dans une vue dédiée, plaçable dans la barre latérale secondaire.

Fonctionnalités de la première version :

- Capture automatique des sorties image des notebooks **et de l'Interactive Window**, sans action de l'utilisateur.
- Affichage de la figure courante, redimensionnée pour remplir le panneau sans déformation.
- Bande de vignettes de tout l'historique de la session, cliquables pour revenir en arrière.
- Navigation au clavier et par boutons dans la barre de titre de la vue.
- Sauvegarde de la figure courante sur disque, dans son format d'origine.
- Réglages : révélation automatique du panneau à l'arrivée d'une figure, suivi ou non de la dernière figure, plafond d'historique.

Ensuite, si la base est solide :

- Persistance de l'historique entre les redémarrages, dans le stockage de l'extension.
- Vignettes réduites pour ne pas garder toutes les figures en pleine résolution en mémoire.
- Copie de la figure courante dans le presse-papiers, export de tout l'historique.

## Hors périmètre

- **Ne réimplémente pas le suivi des variables.** L'extension Jupyter fournit déjà une vue Variables, déplaçable dans la barre latérale secondaire. La dupliquer imposerait d'interroger le kernel en boucle avec du code injecté : plus fragile, plus lent, pour un résultat inférieur. Documente simplement dans le README comment la déplacer au-dessus du panneau de figures.
- Pas de fonctionnalité R, pas de Quarto, pas d'intégration IA.

## Contraintes dures

Ce ne sont pas des préférences. En violer une, c'est un échec, pas un compromis.

1. **Zéro dépendance à l'exécution.** Dépendances de développement uniquement : TypeScript, les paquets de types, et l'outillage de test. Je veux pouvoir faire relire cette extension par une équipe sécurité en entreprise, et c'est l'arbre de dépendances qui fait échouer ce genre de revue.
2. **Aucun accès réseau, aucune télémétrie.**
3. **API VS Code stable uniquement.** Pas d'API proposée : elles sont inutilisables dans un build installé.
4. **TypeScript strict**, compilation sans erreur ni `any`.
5. **Webview sécurisé** : Content-Security-Policy avec nonce généré à chaque rendu, pas de gestionnaire d'événement en ligne, pas d'`innerHTML` avec des données interpolées.
6. **Style natif** : toutes les couleurs viennent des variables de thème `--vscode-*`. Le panneau doit être indiscernable d'un panneau intégré, en thème clair comme en thème sombre. Aucune couleur en dur.

## Pièges connus

Je te donne ces points parce que je les ai déjà rencontrés. Vérifie-les, ne les prends pas pour argent comptant.

- VS Code modélise l'Interactive Window comme un document notebook. C'est probablement la clé pour capturer les deux cas avec un seul mécanisme, plutôt que de traiter séparément notebooks et console interactive.
- Les événements de changement de sortie de cellule se déclenchent plusieurs fois pour une même exécution. Sans déduplication, l'historique se remplit de doublons. Déduplique sur le contenu, pas sur un identifiant fourni par l'API.
- Un kernel propose souvent plusieurs représentations MIME de la même sortie. Il faut choisir la plus riche, en préférant le vectoriel au bitmap.
- Les sorties interactives qui passent par un widget plutôt que par une image — plotly, bokeh, ipywidgets — n'ont pas d'image statique à récupérer. Le comportement attendu est un message explicite, pas un silence.
- Le réglage `jupyter.generateSVGPlots` change ce que le kernel émet. À mentionner dans le README.

Si tu préfères découvrir l'architecture par toi-même, ignore cette section et dis-le-moi dans ton plan.

## Livrables

- Le squelette complet du projet : `package.json`, `tsconfig.json`, `.gitignore`, `.vscodeignore`, licence MIT.
- Le code source en TypeScript, découpé en modules cohérents.
- Un `CLAUDE.md` à la racine, écrit par toi une fois l'architecture stabilisée. Il doit contenir : ce qu'est le projet, la carte des modules et le rôle de chacun, les contraintes dures ci-dessus reformulées comme critères d'échec, les conventions de code que tu as adoptées, et les commandes de vérification. C'est le fichier que liront tes prochaines sessions — écris-le pour quelqu'un qui n'a pas ce brief sous les yeux.
- Un `README.md` : ce que fait l'extension, en quoi elle diffère du Plot Viewer intégré, comment la construire, l'installer, la placer dans la barre latérale secondaire à côté de la vue Variables, tableau des réglages, et limites connues.
- Des tests avec `@vscode/test-cli`, couvrant au minimum la déduplication, l'éviction quand le plafond est atteint, et le choix du type MIME.
- Un `.vsix` installable produit par `vsce package`.

## Méthode

Présente-moi un plan avant de coder : architecture envisagée, découpage en jalons, et les points où tu anticipes une limite de l'API.

Ensuite, procède par jalons. Chacun se termine par une compilation propre, les tests qui passent, et un commit atomique dont le message explique le pourquoi. N'enchaîne pas trois jalons dans un seul gros changement — je relis au fur et à mesure.

Le commit initial existe déjà, ne réécris pas l'historique.

Si une fonctionnalité s'avère impossible avec l'API stable, arrête-toi et dis-le. Je préfère une fonctionnalité en moins qu'un contournement par API proposée ou une façade qui simule le comportement. Les contraintes dures priment sur l'accomplissement de la tâche.

## Fini quand

- `npm run compile` et `npm test` passent.
- `vsce package` produit un `.vsix`.
- Le test manuel fonctionne : F5, ouvrir un `.py` avec une cellule `# %%` qui appelle `plt.plot(...)`, exécuter dans l'Interactive Window, la figure apparaît seule dans le panneau ; réexécuter ne crée pas de doublon ; une deuxième figure ajoute une vignette et le clic sur la première y revient.
- Le README décrit le comportement réel, pas le comportement souhaité.
