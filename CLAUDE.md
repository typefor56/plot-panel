# Plot Panel — notes pour les prochaines sessions

## Ce qu'est ce projet

Extension VS Code qui capture automatiquement les figures produites par les
kernels Jupyter — dans les notebooks **et** dans l'Interactive Window — et les
affiche dans une vue dédiée (figure courante en grand, bande de vignettes
cliquables), plaçable dans la barre latérale secondaire. C'est l'équivalent du
panneau Plots de RStudio/Positron, que le Plot Viewer de l'extension Jupyter ne
fournit pas. Le suivi des variables est volontairement hors périmètre : la vue
Variables de l'extension Jupyter fait déjà ce travail (voir README).

## Carte des modules

| Module | Rôle |
| --- | --- |
| `src/extension.ts` | `activate()` : instancie et câble tous les modules, expose `PlotPanelApi` pour les tests |
| `src/types.ts` | `PlotEntry` et types partagés |
| `src/mime.ts` | Choix de la meilleure représentation MIME (vectoriel > bitmap), détection des sorties widget, extensions de fichiers. Pur, sans `vscode` |
| `src/hash.ts` | Identité de contenu (SHA-256 de mime + octets), clé de déduplication |
| `src/history.ts` | Modèle d'historique : ajout/dédup, éviction FIFO au plafond, sémantique de sélection, événements. Pur, sans `vscode` |
| `src/capture.ts` | Abonnement à `onDidChangeNotebookDocument`, extraction des sorties image, notification explicite pour les widgets |
| `src/plotsView.ts` | `WebviewViewProvider` : HTML statique + CSP à nonce, protocole de messages, réhydratation à chaque `resolveWebviewView` |
| `src/commands.ts` | Commandes : navigation, effacement, sauvegarde (format d'origine), copie, export global |
| `src/persistence.ts` | `PlotStore` : fichiers image adressés par contenu + vignettes `<id>.thumb.png` + `index.json` dans `globalStorageUri`, écritures sérialisées et idempotentes |
| `src/thumbnails.ts` | `ThumbnailCache` : vignettes PNG réduites partagées entre vue et persistance |
| `media/main.js` / `main.css` | Côté webview : rendu, vignettes, clavier. Tout le DOM est construit par API, jamais par HTML interpolé |
| `src/test/*.test.ts` | Suites `@vscode/test-cli` exécutées dans un vrai hôte d'extension |

Flux : kernel → `onDidChangeNotebookDocument` → `capture` → `history` (source de
vérité unique) → événements → `plotsView` (projection webview) et `persistence`
(miroir disque). Les commandes n'agissent que sur `history`.

## Contraintes dures = critères d'échec

Toute violation est un échec du projet, pas un compromis acceptable :

1. **Une dépendance de production apparaît dans `package.json`** (`dependencies`
   non vide, ou `npm ls --omit=dev` non vide). Tout doit tenir avec l'API
   VS Code et les builtins Node.
2. **Un accès réseau ou de la télémétrie à l'exécution.** Rien ne sort de la
   machine. (Le téléchargement de VS Code par `@vscode/test-cli` au premier
   `npm test` est du dev-time, pas du runtime.)
3. **Une API proposée (`enabledApiProposals`, `vscode.proposed.*`)** — l'extension
   doit fonctionner installée depuis un `.vsix`.
4. **Une erreur ou un avertissement `tsc`, ou un `any`** (implicite ou explicite).
5. **Un webview sans CSP à nonce, un gestionnaire d'événement en ligne, ou un
   `innerHTML`/HTML interpolé avec des données.**
6. **Une couleur en dur dans le webview** — uniquement des variables `--vscode-*`.

## Décisions tranchées seul (et pourquoi)

- **Dédup par SHA-256 de (mime + octets)**, jamais par identifiant d'API : les
  événements de sortie se déclenchent plusieurs fois par exécution ; seul le
  contenu est fiable. Conséquence assumée : re-exécuter un code qui produit une
  image octet-pour-octet identique ne crée pas de doublon, la sélection saute
  sur l'entrée existante (mode suivi).
- **Capture sur tous les `notebookType`**, pas une liste blanche : l'Interactive
  Window est un notebook (`notebookType: "interactive"`), et n'importe quel
  kernel émettant des images en profite. C'est aussi ce qui permet aux tests de
  piloter la capture avec leur propre type de notebook.
- **Les sorties widget (plotly, bokeh, ipywidgets…) produisent un message
  explicite** dans la vue, pas une entrée d'historique : il n'y a pas d'image à
  conserver, et une entrée fantôme casserait sauvegarde/export.
- **Ordre MIME : `image/svg+xml` > `image/png` > `image/webp` > `image/jpeg` >
  `image/gif` > `image/bmp`** — vectoriel d'abord, puis fidélité décroissante.
- **Sélection** : le premier plot est sélectionné même sans mode suivi ; un
  doublon re-sélectionne l'entrée existante en mode suivi ; si l'entrée
  sélectionnée est évincée, repli sur la plus ancienne survivante.
- **Persistance = réconciliation complète et idempotente** du dossier à chaque
  changement (fichiers adressés par contenu + `index.json`), sérialisée dans une
  file de promesses : un crash peut perdre les dernières figures, jamais
  corrompre le magasin. Intégrité vérifiée au rechargement (re-hash).
- **Tests de capture via un `NotebookController` de test** : l'API stable
  n'offre aucun `NotebookEdit` pour écrire des sorties ; seul un kernel le peut.
  Le contrôleur de test emprunte donc le vrai pipeline d'exécution (type
  `jupyter-notebook` fourni par l'extension intégrée `vscode.ipynb`, d'où les
  extensions intégrées actives dans l'hôte de test).
- **Vignettes générées côté webview** (canvas) puis renvoyées à l'extension :
  Node n'a aucun décodeur d'image sans dépendance native. La réhydratation
  n'envoie que les vignettes + la figure sélectionnée ; le reste est servi à la
  demande (`requestImage`). SVG = sa propre vignette.
- **Copie presse-papiers dans le webview** (`navigator.clipboard`) :
  `vscode.env.clipboard` ne transporte que du texte. La vue est focalisée
  d'abord (le presse-papiers exige un document focalisé) ; conversion en PNG
  sur canvas pour les formats non-PNG ; échec remonté en message d'erreur.
- **`activate()` expose `ready`** (promesse de fin de restauration) pour que
  les tests ne courent pas contre la restauration asynchrone de l'historique
  persistant. `autoReveal` n'est branché qu'après restauration.
- **Version de VS Code de test épinglée** dans `.vscode-test.mjs` (cache de
  323 Mo réutilisé, exécutions reproductibles).

## Conventions

- TypeScript strict maximal (voir `tsconfig.json`, y compris
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
- Modules purs (`history`, `mime`, `hash`) sans import `vscode` : testables
  finement, réutilisables côté webview si besoin.
- Le webview est une projection sans état propre : source de vérité unique dans
  `history`, réhydratation complète à chaque `resolve` (les `WebviewView` n'ont
  pas de `retainContextWhenHidden`).
- Messages webview typés (`ToWebviewMessage`/`FromWebviewMessage`) dans
  `plotsView.ts`.
- Anglais dans le code et l'UI, commits en anglais, un commit par jalon.

## Commandes de vérification

```sh
npm run compile        # tsc strict, doit être silencieux
npm test               # suites dans un vrai hôte d'extension (télécharge VS Code au premier lancement)
npm run package        # produit le .vsix (non committé)
npm ls --omit=dev      # doit être vide : arbre de dépendances de production
```
