# Livret technique de la logique matchmaking

Ce document explique comment la logique multijoueur fonctionne aujourd'hui, pourquoi elle tient, et ce qu'il ne faut pas casser quand on modifie l'ouverture des salles.

## 1. Principe général

Le matchmaking repose sur une règle simple :

1. un joueur clique sur `Jouer`
2. le serveur cherche une room `waiting` compatible
3. s'il en trouve une, il y place le joueur
4. sinon, il crée une nouvelle room

Une room contient toujours 4 seats au total :
- `1 humain + 3 bots`
- `2 humains + 2 bots`
- `3 humains + 1 bot`
- `4 humains + 0 bot`

Le serveur décide toujours combien d'humains et de bots la room contient au moment réel du démarrage.

## 2. Source de vérité

La vérité du matchmaking est côté serveur dans :
- [functions/index.js](/home/leo/Music/domino%20v1/functions/index.js)

Le client dans :
- [logiquejeu.js](/home/leo/Music/domino%20v1/logiquejeu.js)

ne doit faire que :
- rejoindre une room
- afficher l'attente
- afficher le compte à rebours
- réveiller le serveur si la room doit démarrer

Le client ne doit jamais décider seul qu'une partie commence.

## 3. Cycle exact d'une room

### 3.1 Création

Quand aucune room compatible n'est ouverte, `joinMatchmaking` crée une room avec :
- `status = "waiting"`
- `humanCount = 1`
- `botCount = 3`
- `waitingDeadlineMs = createdAtMs + 15000`

Important :
- le délai de 15 secondes part à la création de la room
- il ne repart jamais à zéro quand un nouveau joueur entre

### 3.2 Remplissage

Quand un autre joueur clique sur `Jouer`, le serveur cherche une room `waiting` :

ordre de priorité :
1. `humanCount` le plus élevé
2. `createdAtMs` le plus ancien

But :
- remplir d'abord la room la plus proche d'être complète
- éviter de fragmenter les joueurs dans plusieurs rooms

### 3.3 Démarrage

Une room passe de `waiting` à `playing` seulement si l'une des 2 conditions est vraie :

1. `humanCount >= 4`
2. `Date.now() >= waitingDeadlineMs`

Si la room démarre :
- le serveur calcule le vrai `botCount = 4 - humanCount`
- le `6-6` sort
- `startRevealPending` démarre
- les humains ack avec `ackRoomStartSeen`
- ensuite seulement la partie se libère

## 4. Pourquoi le bug des 4 joueurs existait

Le bug venait de 2 erreurs de conception :

### 4.1 Le timer de 15s était client-side

Chaque client lançait son propre timer local au moment où il rejoignait la room.

Conséquence :
- la room pouvait partir trop tôt
- un 4e joueur arrivait alors trop tard
- il tombait dans une autre room

### 4.2 La sélection de room ne remplissait pas d'abord la plus pleine

Le tri serveur favorisait surtout l'ancienneté.

Conséquence :
- si plusieurs rooms `waiting` existaient, les joueurs pouvaient être répartis inutilement
- on obtenait des salles `2+1+1` ou `2+2` au lieu d'une salle pleine

## 5. Ce qui tient la logique aujourd'hui

### 5.1 Invariant 1 : le délai est serveur-authoritative

Champ critique :
- `waitingDeadlineMs`

À ne pas casser :
- le serveur doit rester le seul décideur du passage `waiting -> playing`

### 5.2 Invariant 2 : une room expirée ne doit plus accepter de nouveau joueur

Si une room `waiting` a dépassé son `waitingDeadlineMs` :
- elle doit être démarrée
- puis retirée du pool des rooms rejoignables

Sinon :
- un joueur peut entrer dans une room qui aurait déjà dû partir

### 5.3 Invariant 3 : la room la plus pleine doit être prioritaire

Le tri des rooms `waiting` doit toujours favoriser :
- `humanCount` décroissant
- puis `createdAtMs` croissant

Sinon :
- on re-fragmente les joueurs

### 5.4 Invariant 4 : le client n'envoie qu'un nudge

`ensureRoomReady` est un réveil serveur, pas une autorité métier.

Le client peut l'appeler plusieurs fois sans danger.
La transaction serveur doit rester idempotente.

## 6. Fichiers sensibles

### Serveur
- [functions/index.js](/home/leo/Music/domino%20v1/functions/index.js)

Zones sensibles :
- `joinMatchmaking`
- `ensureRoomReady`
- la logique de création de room
- la logique de démarrage de room

### Client
- [logiquejeu.js](/home/leo/Music/domino%20v1/logiquejeu.js)

Zones sensibles :
- `startMatchmaking`
- `watchRoom`
- le countdown d'attente
- `startRoomIfNeeded`

## 7. Ce qu'il ne faut pas faire

- Ne remets pas un `setTimeout(...15s)` local comme source de vérité
- Ne repars pas le timer à chaque joueur entrant
- Ne laisse pas une room expirée rester rejoignable
- Ne priorise pas une room moins pleine au détriment d'une room presque complète
- Ne touche pas au reveal `6-6` juste pour corriger le matchmaking
- Ne déplace pas la logique de décision du serveur vers le client

## 8. Symptômes typiques

### Symptom: le 4e joueur part dans une autre room
Ca veut souvent dire :
- timer local revenu dans le flux
- room expirée encore rejoignable
- tri de rooms incorrect

### Symptom: une room démarre trop tôt
Ca veut souvent dire :
- `ensureRoomReady` appelé trop tôt et accepté sans vérifier `waitingDeadlineMs`

### Symptom: plusieurs rooms se remplissent mal
Ca veut souvent dire :
- tri `waiting` incorrect
- filtre de compatibilité incomplet

## 9. Checklist de test après modification

1. `1 joueur` crée une room et démarre à 15s avec 3 bots
2. `2 joueurs` dans la même room avant 15s
3. `3 joueurs` dans la même room avant 15s
4. `4 joueurs` dans la même room avant 15s
5. le countdown s'arrête immédiatement quand le 4e arrive
6. aucun bot si 4 humains
7. un joueur qui arrive après expiration ne rejoint pas la room déjà partie
8. plusieurs rooms `waiting` se remplissent dans le bon ordre
9. le reveal `6-6` reste intact
10. aucun joueur ne reste bloqué en "préparation sécurisée" après démarrage

## 10. Stratégie sûre pour l'avenir

Si tu modifies encore cette logique :

1. lis d'abord [jeu.md](/home/leo/Music/domino%20v1/jeu.md)
2. touche seulement `joinMatchmaking`, `ensureRoomReady` et l'affichage d'attente
3. ne touche pas au moteur domino si le problème est un problème de room
4. reteste toujours avec :
   - 1 joueur
   - 2 joueurs
   - 3 joueurs
   - 4 joueurs
   - arrivée tardive après expiration

La règle à garder en tête :
- le serveur décide quand une salle commence
- le client ne fait qu'afficher et réveiller
