# Withdrawal Balance Fix

Date: 2026-03-18

## Problem

Le site autorisait bien un utilisateur a:

- deposer des HTG
- convertir ces HTG en Does
- jouer et gagner des Does
- reconvertir ses Does en HTG

Mais la demande de retrait etait encore validee avec une ancienne logique:

- `solde autorise retrait = depots approuves - retraits reserves`

Cette formule ignore `exchangedGourdes` dans le wallet. Or cette valeur est deja utilisee par `xchange.js` pour calculer le vrai solde HTG disponible:

- si `exchangedGourdes` est positif, une partie du depot est encore bloquee dans Does
- si `exchangedGourdes` devient negatif apres des gains reconvertis, le solde HTG disponible peut depasser le depot initial

Resultat concret:

- depot initial: `100 HTG`
- le joueur gagne en Does puis revend
- l'UI peut afficher `250 HTG`
- mais le backend du retrait refusait encore tout montant au-dessus de `100 HTG`

## Files Changed

### `functions/index.js`

Ajout de helpers pour centraliser le calcul financier:

- `computeOrderAmount(order)`
- `computeReservedWithdrawalAmount(withdrawal)`
- `computeWalletAvailableGourdes(...)`

Ces helpers sont maintenant utilises dans:

- la validation `xchange_buy`
- la validation `createWithdrawalSecure`

Nouvelle formule de reference cote serveur:

`availableBalanceHtg = max(0, (approvedDeposits - reservedWithdrawals) - exchangedGourdes)`

Effet:

- les HTG encore convertis en Does restent bloques
- les gains reconvertis en HTG deviennent retirables
- la logique de retrait est maintenant alignee avec la logique du wallet affiche au client

### `solde.js`

Ajout des memes helpers de montant cote client pour eviter les divergences locales:

- les depots approuves sont recalcules avec `amount` ou, si besoin, via `items`
- les retraits reserves utilisent `requestedAmount ?? amount`

Le recalcul de base du badge reste le meme dans l'esprit, mais il est maintenant plus robuste et plus coherent avec le backend.

## Why This Fix Is Safe

- On ne change pas le modele du wallet existant.
- On ne change pas les mutations `xchange_buy`, `xchange_sell` ou `game_reward`.
- On aligne seulement la validation du retrait avec la source de verite deja utilisee par le systeme d'Xchange.
- Le comportement deja correct continue de marcher:
  - depot simple
  - conversion HTG -> Does
  - revente Does -> HTG
  - retrait inferieur ou egal au vrai solde HTG

## Important Mental Model For Future Devs

Il y a 3 notions distinctes:

1. `approvedDeposits`
   C'est la base historique venant des commandes approuvees.

2. `reservedWithdrawals`
   C'est ce qui est deja reserve par des demandes de retrait non rejetees.

3. `exchangedGourdes`
   C'est la projection HTG du wallet Does:
   - positif = HTG encore immobilises dans Does
   - negatif = gains net reconvertis depuis les Does

Le solde HTG disponible ne doit pas etre calcule avec les depots seuls.
Il doit toujours prendre en compte `exchangedGourdes`.

## Remaining Note

La regle "un utilisateur doit d'abord convertir tout son depot en Does avant de retirer" reste actuellement verifiee dans `retrait.js`.

Cette correction n'a pas deplace cette regle vers le backend pour ne pas changer le comportement metier plus que necessaire dans ce patch.
Si un durcissement securite est prevu plus tard, cette verification pourra etre dupliquee cote `createWithdrawalSecure`.
