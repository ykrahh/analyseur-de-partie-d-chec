# Analyseur d'échecs — Stockfish local

Analyse tes parties chess.com avec un vrai Stockfish qui tourne sur ta machine,
via une extension Chrome. Même moteur, même logique de conversion en
probabilité de victoire et de précision que chess.com (formule publiée par
Lichess, très proche de la CAPS2 de chess.com), sans dépendre de leur service.

## Comment ça marche

```
chess.com API  →  extension (page dédiée)  →  serveur local (localhost:8791)  →  Stockfish
   (tes PGN)        parsing + affichage         file d'attente multi-cœurs        (natif, brew)
```

- Le **serveur** (`server/`) est un petit programme Node qui pilote plusieurs
  processus Stockfish en parallèle (un par cœur disponible) et les expose en
  HTTP sur `127.0.0.1:8791`. Rien ne sort de ta machine.
- L'**extension** (`extension/`) ouvre une page qui récupère tes parties via
  l'API publique de chess.com (`api.chess.com/pub/player/...`, pas de clé
  nécessaire), les envoie au serveur local pour analyse, et affiche
  l'échiquier, la courbe d'évaluation, la précision et le classement de
  chaque coup (Meilleur coup, Excellent, Imprécision, Erreur, Gaffe, etc.).

## Installation

### 1. Le serveur (déjà fait, à relancer si besoin)

Stockfish est installé via Homebrew (`/opt/homebrew/bin/stockfish`) et les
dépendances Node sont installées dans `server/`.

Pour démarrer le serveur :

```bash
~/chess-analyzer/start-server.sh
```

Laisse ce terminal ouvert pendant que tu utilises l'extension (ou lance-le en
arrière-plan). Tu peux vérifier qu'il tourne avec :

```bash
curl http://127.0.0.1:8791/health
```

### 2. L'extension Chrome

1. Ouvre `chrome://extensions`
2. Active le **mode développeur** (interrupteur en haut à droite)
3. Clique **Charger l'extension non empaquetée**
4. Sélectionne le dossier `~/chess-analyzer/extension`
5. Épingle l'icône de l'extension dans la barre d'outils

## Utilisation

1. Clique sur l'icône de l'extension → une page s'ouvre dans un nouvel onglet.
2. Le point en haut à droite doit être **vert** ("Moteur local actif") — sinon,
   relance `start-server.sh`.
3. Entre ton pseudo chess.com, clique **Charger** → tes parties récentes
   (mois en cours + précédent) apparaissent à gauche.
4. Clique sur une partie, puis **Analyser cette partie**.
5. Une fois l'analyse terminée : précision de chaque camp, courbe
   d'évaluation, échiquier navigable (flèches ◀▶, autoplay, ou clic sur un
   coup dans la liste), et classification de chaque coup.

Réglage de **profondeur** (dans la barre latérale) :
- **Rapide (14)** : quelques secondes par position, bon pour un premier coup d'œil
- **Équilibré (18)** : par défaut, proche de la précision de chess.com, une partie complète prend ~1 à 2 minutes
- **Profond (22)** : plus précis, nettement plus lent

## Comment la précision est calculée

C'est la même logique que chess.com/Lichess, en deux étapes :

1. **Centipions → probabilité de victoire** : une sigmoïde convertit l'éval
   Stockfish en % de chances de gagner. Ça évite l'écueil des centipions bruts
   (perdre 100cp à +900 ne compte presque pas ; perdre 100cp à égalité est une
   vraie faute).
2. **Précision du coup** = `103.1668 × exp(-0.04354 × perte_%) - 3.1669`,
   où `perte_%` est la chute de probabilité de victoire causée par le coup.
   La précision globale de la partie combine la moyenne simple et une moyenne
   pondérée par la volatilité locale (les moments critiques comptent plus),
   via une moyenne harmonique — c'est la méthode documentée par Lichess.

## Limites connues (honnêteté avant tout)

- **"Théorie" (Book)** et **"Brillant"** sont des heuristiques approximatives :
  chess.com ne publie pas ses seuils exacts pour ces deux catégories.
  "Théorie" se base sur les premiers coups seulement (pas de vraie base
  d'ouvertures). "Brillant" détecte les sacrifices évidents (une pièce offerte
  qui est immédiatement prise) dans une position pas encore totalement décidée
  — il peut rater des cas plus subtils ou, plus rarement, une position déjà
  quasi gagnée où humainement le coup mériterait le label.
- Toutes les autres catégories (Meilleur coup, Excellent, Bon, Imprécision,
  Erreur, Gaffe, Occasion manquée) reposent directement sur l'éval Stockfish
  et la formule ci-dessus — c'est la partie fiable et vérifiée.
- **Le pourcentage de précision lui-même lira presque toujours un peu plus
  généreux que celui de chess.com.** Ce n'est pas un bug qu'on peut corriger :
  chess.com confirme dans sa propre documentation que son score CAPS2 est
  *volontairement recalibré* (non public) pour que la plupart des scores
  tombent entre 50 et 95, spécifiquement pour éviter qu'une partie très bonne
  mais pas parfaite arrondisse à 99,9 — ce que faisait leur ancienne version
  CAPS1. On utilise la formule publique de Lichess (la seule documentée),
  qui n'a pas cette recalibration. Deux retours indépendants trouvés en
  ligne donnent un écart d'environ 15 points sur la même partie (74% chess.com
  vs 89% Lichess ; 77% vs 92%) — mais ce n'est que 2 exemples anecdotiques,
  pas une mesure fiable, donc on ne l'a pas appliqué par défaut.

## Démarrage automatique du serveur (optionnel)

Le serveur ne démarre pas tout seul au démarrage de ta session — il faut lancer
`start-server.sh` toi-même à chaque fois. Si tu veux qu'il démarre
automatiquement à la connexion, dis-le moi explicitement : je peux mettre en
place un agent de lancement macOS (LaunchAgent), mais je ne l'installe pas
sans ton accord explicite car c'est un mécanisme qui persiste au-delà de
cette session.

## Structure du projet

```
chess-analyzer/
├── server/
│   ├── engine.js      # wrapper UCI + pool de processus Stockfish
│   ├── index.js        # serveur HTTP (Express)
│   └── package.json
├── extension/
│   ├── manifest.json
│   ├── background.js   # ouvre la page d'analyse au clic sur l'icône
│   ├── lib/chess.js     # chess.js (parsing PGN/FEN, règles du jeu)
│   └── page/
│       ├── analyzer.html/css
│       ├── analysis.js  # calculs purs : win%, précision, classification
│       └── app.js       # UI, appels à l'API chess.com et au serveur local
└── start-server.sh
```
