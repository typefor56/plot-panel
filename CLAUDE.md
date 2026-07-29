# Plot Panel — notes pour les prochaines sessions

## Ce qu'est ce projet

Extension VS Code qui capture automatiquement les figures produites par les
kernels Jupyter — dans les notebooks **et** dans l'Interactive Window — et les
affiche dans une vue dédiée (figure courante en grand, bande de vignettes
cliquables), plaçable dans la barre latérale secondaire. C'est l'équivalent du
panneau Plots de RStudio/Positron, que le Plot Viewer de l'extension Jupyter ne
fournit pas. S'y ajoutent la toolbar Positron (zoom, sizing policy, filtre
sombre, actions sur le code du plot), la galerie/plots en onglets ou fenêtres
flottantes, et une vue **Jupyter Variables** (catégories DATA/VALUES/
FUNCTIONS/CLASSES, filtre, expansion des enfants quand l'API Kernels est
accessible). NB : le brief initial excluait le suivi des variables ; cette
décision a été **inversée à la demande de l'utilisateur** (session 2026-07-29),
avec un périmètre Python uniquement.

## Carte des modules

| Module | Rôle |
| --- | --- |
| `src/extension.ts` | `activate()` : instancie et câble tous les modules, expose `PlotPanelApi` pour les tests |
| `src/types.ts` | `PlotEntry` et types partagés |
| `src/mime.ts` | Choix de la meilleure représentation MIME (vectoriel > bitmap), détection des sorties widget, extensions de fichiers. Pur, sans `vscode` |
| `src/hash.ts` | Identité de contenu (SHA-256 de mime + octets), clé de déduplication |
| `src/history.ts` | Modèle d'historique : ajout/dédup, éviction FIFO au plafond, sémantique de sélection, événements. Pur, sans `vscode` |
| `src/capture.ts` | Abonnement à `onDidChangeNotebookDocument`, extraction des sorties image + métadonnées de code de la cellule, notification explicite pour les widgets |
| `src/webviewSession.ts` | `PlotWebviewSession` : tout le per-webview (squelette CSP à nonce, handshake `ready`→`state`, protocole, copie), partagé entre vue latérale et panneaux ; modes `gallery`/`single` |
| `src/sessionRegistry.ts` | Registre des sessions vivantes ; notice sticky broadcastée et survivant à la réhydratation |
| `src/plotsView.ts` | `WebviewViewProvider` mince : attache une session gallery à chaque `resolveWebviewView` |
| `src/galleryPanel.ts` | `PanelManager` : galerie singleton + panneaux plot épinglés en `WebviewPanel`, serializers de reload, « new window » via `moveEditorToNewWindow` |
| `src/displayOptions.ts` | `DisplayMode` (enum plat zoom+sizing, dernier choisi gagne) + filtre sombre, persistés en `globalState`, émetteur maison |
| `src/contextKeys.ts` | Clés de contexte `when` centralisées (seul module autorisé à appeler `setContext`) : `plotPanel.selectedHasCode` |
| `src/codeActions.ts` | Copy/Reveal/Rerun du code d'un plot, best-effort avec erreurs explicites |
| `src/commands.ts` | Enregistrement de toutes les commandes ; sur un panneau épinglé actif, save/copy/code agissent sur le pin |
| `src/persistence.ts` | `PlotStore` : fichiers image adressés par contenu + vignettes `<id>.thumb.png` + `index.json` dans `globalStorageUri`, écritures sérialisées et idempotentes |
| `src/thumbnails.ts` | `ThumbnailCache` : vignettes PNG réduites partagées entre vue et persistance |
| `src/variables/categorize.ts` | Catégorisation DATA/VALUES/FUNCTIONS/CLASSES, hints, `formatVariableValue` (forme/aperçus élidés), `variableSize`/`variableCount`, `organizeVariables` (groupement kind/size × tri name/size/recent), `dataViewerType`. Pur, sans `vscode` |
| `src/variables/reprParse.ts` | Parseurs des reprs SafeRepr : paires d'une Series, grille d'un DataFrame, items de collections, `elideItems`. Pur, testé sur fixtures pandas réelles (`src/test/reprFixtures.ts`, généré) |
| `src/variables/summary.ts` | Parseur du `summary` (= `df.info()`) attaché aux DataFrames. Pur |
| `src/variables/inspect.ts` | Snippet Python d'inspection (enfants d'une expression, sentinelle JSON) + parseur. Pur, sans `vscode` |
| `src/variables/jupyterApi.ts` | Adaptateur Jupyter : `jupyter.listVariables` (stable) + sonde API Kernels pour l'expansion profonde |
| `src/variables/variablesOptions.ts` | Groupement/tri de la vue Variables, persistés en `globalState` (patron displayOptions) |
| `src/variables/variablesView.ts` | `WebviewViewProvider` de la vue Variables : décorations cachées par fetch, `fallbackChildren` (tables 2 colonnes), récence par signature, bouton data viewer, rafraîchissement en fin d'exécution (debounce 500 ms) |
| `media/main.js` / `main.css` | Côté webview plots : rendu, vignettes, clavier, modes d'affichage. Tout le DOM est construit par API, jamais par HTML interpolé |
| `media/variables.js` / `variables.css` | Côté webview variables : sections repliables, filtre client, expansion à la demande. Même doctrine DOM |
| `src/test/*.test.ts` | Suites `@vscode/test-cli` exécutées dans un vrai hôte d'extension |

Flux : kernel → `onDidChangeNotebookDocument` → `capture` → `history` (source de
vérité unique) → événements → sessions webview (projections : vue latérale,
galerie, panneaux épinglés) et `persistence` (miroir disque). Les commandes
n'agissent que sur `history` et `displayOptions`. Variables : même événement →
`variablesView` → `jupyter.listVariables` (pull, pas d'événement de changement
côté Jupyter).

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
- **Un seul enum `DisplayMode`** pour zoom et sizing policy (états mutuellement
  exclusifs, le dernier choisi gagne ; « 100 % » = « Actual size »). Persisté
  en `globalState` avec le filtre sombre : ce sont des toggles de toolbar, pas
  des réglages méritant une entrée settings.
- **Le filtre sombre est une fonction CSS `filter`** (`invert(1)
  hue-rotate(180deg)`), pas une couleur : la contrainte 6 reste respectée.
- **Les métadonnées de code** (`code` plafonné à 10 k, `notebookUri`,
  `cellIndex`, `originUri`/`originLine` pour l'IW) sont **optionnelles et
  additives** dans `index.json` : `INDEX_VERSION` reste à 1 (le bump
  effacerait l'historique de tout le monde ; le garde `isRecord` tolérant
  assure la compat dans les deux sens). La dédup par contenu fait qu'un
  doublon octet-pour-octet garde les métadonnées de la première capture.
- **Reveal/rerun retrouvent la cellule par texte exact d'abord**, indice
  capturé en repli : les cellules bougent, le texte est plus fiable ; best
  effort assumé avec erreurs explicites.
- **Variables en deux couches** : `jupyter.listVariables` (commande contribuée
  stable, top-level uniquement, pull) partout ; expansion **profonde** via
  l'API Kernels (`@vscode/jupyter-extension`, devDependency types-only —
  l'arbre de prod reste vide). Cette API est **verrouillée par publisher** :
  accordée en `extensionMode === Test` et sur Insiders, refusée (avec toast
  d'erreur Jupyter) aux publishers inconnus sur stable. La sonde ne tourne
  donc que là où l'accès est possible ; ailleurs, **repli stable** : le champ
  `summary` que Jupyter attache aux DataFrames (= sortie de `df.info()`,
  cachée par executionCount) est parsé (`variables/summary.ts`) pour offrir
  un niveau d'expansion — colonnes avec non-null count et dtype (pandas omet
  ce tableau au-delà de 100 colonnes → ligne non dépliable). Faits vérifiés
  dans le build installé : `value` = SafeRepr (max 64 k, la queue
  `[N rows x M columns]` d'un DataFrame y survit — extraite pour l'affichage
  Positron), `count` seulement pour list/tuple/set, **fonctions/classes/
  modules exclus kernel-side** (sections FUNCTIONS/CLASSES vides via cette
  source), `variable.expression` fourni. `jupyter.listVariables` n'existe pas
  dans l'hôte de test (rejet « command not found », pas `[]`) : l'adaptateur
  try/catch tout, et seuls `categorize`/`inspect`/`summary` (purs) sont
  testés.
- **La catégorisation DATA/VALUES/FUNCTIONS/CLASSES est à nous** (Positron ne
  documente pas la sienne) : dernier segment du type qualifié — DataFrame/
  Series/Index (pandas/polars) → DATA, callables → FUNCTIONS, `type`/`*Meta` →
  CLASSES, sinon VALUES — **`ndarray` → VALUES**, comme Positron (vérifié
  contre ses captures).
- **Le rafraîchissement des variables est coûteux** (le script d'introspection
  de Jupyter tourne SUR le kernel, en concurrence avec les cellules) : il ne
  se déclenche que vue visible, qu'en **fin d'exécution**
  (`executionSummary.timing`, debounce 500 ms), avec un seul fetch en vol
  (coalescing), et `plotPanel.variablesAutoRefresh: false` le rend manuel.
  Corollaire : chaque fetch est **décoré une fois** (row + size + changedAt +
  `fallbackChildren`) ; changer groupement/tri ne fait que re-projeter ce
  cache, jamais retoucher le kernel ni re-parser.
- **Règle d'or de la vue Variables : toujours 2 colonnes** (nom | valeur,
  hint de type discret à droite, `VALUE_CAP` 80). Expansion en étages :
  l'API Kernels (Insiders/test) exécute le snippet d'inspection ; sur stable,
  `reprParse.ts` transforme les reprs SafeRepr en **tables d'aperçu**
  index | valeur (Series, colonnes d'un DataFrame via sa grille de repr,
  list/tuple/set/ndarray, dict) avec une ligne `⋯` aux troncatures — les
  parseurs préfèrent échouer (undefined) plutôt que produire une table
  fausse (wrap, MultiIndex, coupes 64 k). Fixtures générées avec le vrai
  pandas 2.2.3 + SafeRepr de debugpy, réglages d'affichage de Jupyter.
- **Groupement/tri** (`variablesOptions`, globalState) : Kind (défaut) ou
  Size (LARGE ≥ 100 k éléments / MEDIUM ≥ 1 k / SMALL) ; tri Name (défaut),
  Size desc, Recent desc — récence = signature `type+value(+summary pour les
  DataFrames, dont le repr peut rester identique quand df.info bouge)`
  comparée entre fetchs, par notebook, purgée à la fermeture. Pas de coche
  sur le choix actif (menus natifs) — limite acceptée.
- **« Ouvrir en grand » = `jupyter.showDataViewer`** : chemin **sans gate
  publisher** (vérifié par décompilation, Jupyter 2026.6 + Data Wrangler
  1.24.2) qui transmet l'objet tel quel au viewer contribué. Payload exact :
  `{name: <identifiant OU expression Python — DW l'évalue sur le kernel>,
  type: <membre exact des dataTypes contribués>, fileName: <Uri du notebook
  OUVERT>, value/fullType: undefined, supportsDataExplorer: true, size: 0,
  shape: '', count: 0, truncated: true}` ; **jamais** `frameId` ni de clé
  `variable` (elles reroutent vers les chemins debugger). Workspace trusté
  requis ; si aucun viewer n'est installé, Jupyter affiche lui-même le
  prompt. Une colonne de DataFrame s'ouvre via l'expression `df["col"]`
  (viewerType `Series`).
- **Le snippet d'inspection** encode l'expression cible en double JSON
  (littéral Python + payload), assemble sa sentinelle à l'exécution (un écho
  du code ne peut pas simuler une réponse) et enveloppe chaque accès dans
  try/except (l'expansion peut exécuter des property getters — compromis
  standard des inspecteurs).
- **Toolbars natives partout** (`view/title`, `editor/title` +
  `contributes.submenus`) plutôt qu'une toolbar HTML dans le webview : pas de
  police codicon à embarquer, pas de dropdown à réimplémenter. Limite
  acceptée : pas de coche sur le niveau de zoom actif dans un menu natif.
- **« New window » = panneau créé focalisé puis
  `workbench.action.moveEditorToNewWindow`** (la commande agit sur l'éditeur
  actif).

## Conventions

- TypeScript strict maximal (voir `tsconfig.json`, y compris
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
- Modules purs (`history`, `mime`, `hash`) sans import `vscode` : testables
  finement, réutilisables côté webview si besoin.
- Les webviews sont des projections sans état propre : sources de vérité dans
  `history`/`displayOptions`, réhydratation complète à chaque handshake
  `ready` (ni les `WebviewView` ni nos panneaux n'utilisent
  `retainContextWhenHidden`). Seul état client : filtre et sections repliées
  de la vue Variables, et le `pinnedId` qu'un panneau épinglé stocke via
  `setState` pour survivre au reload.
- Messages webview typés (`ToWebviewMessage`/`FromWebviewMessage`) dans
  `webviewSession.ts` ; protocole distinct dans `variablesView.ts`.
- `setContext` uniquement dans `contextKeys.ts`.
- Anglais dans le code et l'UI, commits en anglais, un commit par jalon.

## Commandes de vérification

```sh
npm run compile        # tsc strict, doit être silencieux
npm test               # suites dans un vrai hôte d'extension (télécharge VS Code au premier lancement)
npm run package        # produit le .vsix (non committé)
npm ls --omit=dev      # doit être vide : arbre de dépendances de production
```
