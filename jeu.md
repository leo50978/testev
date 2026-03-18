# Livret technique du jeu

Ce document explique comment le jeu fonctionne aujourd'hui, pourquoi il tient, et quelles zones sont sensibles. Le but est simple : pouvoir modifier le jeu plus tard sans casser la logique.

## 1. Vue d'ensemble

Le jeu est partagé entre 3 couches :

1. `functions/index.js`
   Source de vérité serveur.
   C'est ici que sont validés les coups, les tours, les bots, les fins de partie et les récompenses.

2. `logiquejeu.js`
   Orchestrateur client multijoueur.
   Il connecte Firebase, la room, les actions réseau, la réhydratation locale, le timer et l'UI du match.

3. `Domino_Partida.js` + `Domino_Ficha.js` + `Domino_UI.js`
   Moteur visuel local.
   Ces fichiers gèrent la table, les dominos, les animations, l'aide visuelle et l'affichage du gagnant.

Le jeu marche bien uniquement si ces 3 couches restent alignées.

## 2. Source de vérité

La source de vérité du match est côté serveur.

Fichiers critiques :
- [functions/index.js](/home/leo/Music/domino%20v1/functions/index.js)
- [secure-functions.js](/home/leo/Music/domino%20v1/secure-functions.js)

Collections critiques :
- `rooms/{roomId}`
- `gameStates/{roomId}`
- `rooms/{roomId}/actions/{seq}`

Règle importante :
- le client affiche
- le serveur décide

Le client ne doit jamais devenir la vérité métier.

## 3. Cycle d'une partie

### 3.1 Entrée en room

Le client rejoint une salle via :
- `joinMatchmaking`
- `ensureRoomReady`

Le serveur crée ou complète la room, prépare le deck, puis démarre la partie.

### 3.2 Début réel du match

Le début visible du match passe par :
- `startRevealPending`
- `ackRoomStartSeen`

Le `6-6` sort d'abord.
Ensuite seulement la partie est libérée pour continuer.

Fichiers :
- [functions/index.js](/home/leo/Music/domino%20v1/functions/index.js)
- [logiquejeu.js](/home/leo/Music/domino%20v1/logiquejeu.js)

### 3.3 Déroulement d'un coup

Quand un joueur joue :

1. le client envoie l'action avec `submitAction`
2. le serveur valide la tuile, le côté et le tour
3. le serveur met à jour `gameStates`
4. le serveur écrit le journal dans `rooms/{roomId}/actions`
5. le serveur met à jour `rooms`
6. les clients rejouent l'action localement

Les bots sont joués côté serveur, jamais côté client.

## 4. Les 2 conditions de victoire

Il y a uniquement 2 façons normales de terminer une manche.

### 4.1 Victoire par dernière tuile

Condition :
- un joueur ou un bot pose sa dernière tuile

Source de vérité :
- [functions/index.js](/home/leo/Music/domino%20v1/functions/index.js)

La logique serveur est :
- on retire la tuile de `seatHands`
- on compte les tuiles restantes du seat
- si le total est `0`, alors :
  - `winnerSeat = move.player`
  - `winnerUid = ...`
  - `endedReason = "out"`
  - la room passe en `status = "ended"`

### 4.2 Victoire par blocage

Condition :
- tout le monde passe
- le plus petit total de points gagne

Source de vérité :
- [functions/index.js](/home/leo/Music/domino%20v1/functions/index.js)

La logique serveur est :
- `passesInRow++`
- si `passesInRow >= 4`
  - calcul du seat avec le plus petit total
  - `endedReason = "block"`
  - la room passe en `status = "ended"`

## 5. Ce que fait le client

Le client ne choisit pas le gagnant final.
Il fait seulement 3 choses :

1. rejouer les actions du serveur localement
2. garder la table visuellement cohérente
3. afficher la fin de partie quand la room serveur confirme `ended`

Fichiers critiques :
- [logiquejeu.js](/home/leo/Music/domino%20v1/logiquejeu.js)
- [Domino_Partida.js](/home/leo/Music/domino%20v1/Domino_Partida.js)
- [Domino_Ficha.js](/home/leo/Music/domino%20v1/Domino_Ficha.js)

## 6. Invariants à ne pas casser

Ce sont les règles internes les plus sensibles.

### 6.1 Le serveur doit rester la vérité

Ne jamais déplacer la logique de victoire ou de validation définitive dans le navigateur.

À ne pas casser :
- `submitAction`
- `applyResolvedMove`
- `buildRoomUpdateFromGameState`
- `processPendingBotTurns`

### 6.2 `actions.seq` est sacré

Chaque action a un `seq` croissant.
Le client rejoue les actions dans cet ordre.

Si tu casses ça :
- réhydratation cassée
- fin de partie cassée
- tours fantômes
- attente infinie côté client

À ne pas casser :
- `SiguienteAccionSeq`
- `lastActionSeq`
- `nextActionSeq`

### 6.3 Les animations ne doivent pas devenir la vérité métier

L'animation ne sert qu'à montrer.
Elle ne doit pas décider à elle seule de la victoire.

Zone sensible :
- [Domino_Ficha.js](/home/leo/Music/domino%20v1/Domino_Ficha.js)

Le moteur historique incrémente encore `TurnoActual` et `JugadorActual` à la fin de certaines animations. C'est une zone fragile. Si tu la touches, il faut retester toute la synchro.

### 6.4 Le reveal de départ est une zone fragile

Le `6-6` visible puis la libération du match dépendent de :
- `startRevealPending`
- `startRevealAckUids`
- `ackRoomStartSeen`

Si tu touches cette zone sans retester à 2 comptes :
- un joueur peut voir le `6-6`
- l'autre peut rester bloqué
- ou les bots peuvent avancer trop tôt

### 6.5 La fin de partie affichée attend 2 choses

Pour une victoire par dernière tuile, le client attend :
- que la room soit confirmée `ended`
- que l'animation locale du dernier domino soit terminée

Zone sensible :
- `ComprobarManoTerminada`
- `MarcarManoTerminadaServidor`

Si tu casses cette attente :
- la victoire peut apparaître trop tôt
- ou ne jamais apparaître

## 7. Zones où il faut faire très attention

### Serveur
- [functions/index.js](/home/leo/Music/domino%20v1/functions/index.js)

Fonctions les plus sensibles :
- `applyResolvedMove`
- `advanceBotsAndCollect`
- `buildRoomUpdateFromGameState`
- `processPendingBotTurns`
- `submitAction`
- `finalizeGame`

### Client multijoueur
- [logiquejeu.js](/home/leo/Music/domino%20v1/logiquejeu.js)

Fonctions les plus sensibles :
- `watchRoom`
- `watchActions`
- `maybeFinishRehydration`
- `onGameEnded`
- `pushAction`

### Moteur local
- [Domino_Partida.js](/home/leo/Music/domino%20v1/Domino_Partida.js)
- [Domino_Ficha.js](/home/leo/Music/domino%20v1/Domino_Ficha.js)

Fonctions les plus sensibles :
- `Turno`
- `AplicarAccionMultijugador`
- `ProcesarPendientes`
- `ComprobarManoTerminada`
- `MarcarManoTerminadaServidor`
- `Colocar`

## 8. Ce qu'il ne faut pas faire

Ne fais pas ces changements sans campagne complète de tests.

- Ne supprime pas les retries de réhydratation "pour simplifier"
- Ne fais pas avancer les bots côté client
- Ne supprime pas `actions`
- Ne rends pas `room.status` secondaire
- Ne modifies pas `tilePos`, `tileLeft`, `tileRight`, `branch`, `seq` sans retester tout le flux
- Ne remets pas le deck dans la room en permanence
- Ne fais pas dépendre la fin de partie uniquement de l'UI

## 9. Ce qu'on peut modifier avec peu de risque

Modifications généralement sûres :
- textes UI
- loaders
- aides visuelles
- habillage des modales
- affichage des messages de statut
- positionnement des boutons

Modifications à risque moyen :
- timers visuels
- prompts d'orientation
- overlay de victoire

Modifications à haut risque :
- tours
- réhydratation
- conditions de victoire
- reveal de départ
- sortie de room en cours de partie

## 10. Quand tu modifies le jeu, voici la checklist minimale

Toujours retester ces cas :

1. démarrage d'une partie 1 humain + bots
2. démarrage d'une partie à 2 comptes
3. sortie visible du `6-6`
4. premier coup humain
5. premier coup bot
6. victoire par dernière tuile joueur
7. victoire par dernière tuile bot
8. victoire par blocage `4 passes`
9. bouton `Aller`
10. `Quitter salle` en pleine partie
11. `Rejouer`
12. reload en cours de partie

## 11. Symptômes typiques d'une casse

Si tu vois ça, la zone cassée est souvent identifiable.

### Le jeu se fige après le `6-6`
Probable :
- reveal
- `ackRoomStartSeen`
- réhydratation

### Le coup est visible mais refusé serveur
Probable :
- désalignement `tilePos`
- deck privé non synchronisé
- mauvaise validation locale

### La partie ne finit pas après la dernière tuile
Probable :
- signal `onGameEnded` perdu
- room pas passée en `ended`
- attente infinie dans `MarcarManoTerminadaServidor`

### Le gagnant s'affiche trop tôt
Probable :
- animation non attendue
- fin locale déclenchée avant confirmation room

## 12. Stratégie saine pour les futures modifs

Quand tu touches au jeu :

1. modifie une seule couche à la fois
2. garde le serveur comme vérité
3. ajoute des logs ciblés plutôt que des patchs aveugles
4. reteste les 12 cas de la checklist
5. si possible, pousse d'abord un correctif petit et isolé

## 13. Résumé simple

Le jeu marche parce que :
- le serveur décide des coups et des victoires
- le client rejoue les actions dans l'ordre
- la table attend les animations avant d'afficher certaines transitions
- la room `ended` reste le signal officiel de fin

Si tu veux éviter de casser le jeu :
- ne touche pas en même temps au serveur, au replay et aux animations
- ne fais jamais du client la source de vérité
- reteste toujours `dernier domino` et `4 passes`
