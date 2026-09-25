#!/bin/bash
# Lance le serveur d'analyse Stockfish local.
# À garder ouvert (ou en arrière-plan) pendant que tu utilises l'extension.
cd "$(dirname "$0")/server" || exit 1
echo "Démarrage du serveur d'analyse sur http://127.0.0.1:8791 ..."
node index.js
