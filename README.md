# Brick Layers — convertisseur G-cod

Outil web qui décale d'une demi-couche les parois intérieures, une couche sur deux, pour transformer l'empilement rectangulaire classique en empilement en briques.

## Pourquoi

Un slicer normal coupe la pièce en tranches 2D et les empile. Toutes les parois s'alignent donc verticalement, ce qui crée un plan de rupture franc entre les couches : c'est là que la pièce casse.

En décalant les parois intérieures d'une demi-hauteur de couche une couche sur deux, les extrusions s'emboîtent en mosaïque. La surface de contact entre deux couches augmente, et la rupture ne se fait plus dans un plan plat mais en zigzag.

Mesures de CNC Kitchen (source de la méthode) : +14 % de résistance en PLA, +10 % en PETG, sans coût de matériau supplémentaire.

## Utilisation

Ouvrir `index.html` dans un navigateur, déposer un `.gcode`, cliquer sur Convertir.

Rien ne quitte l'appareil : la conversion est faite en JavaScript dans l'onglet.

### Réglages du slicer, avant de trancher

Ces contraintes viennent de la façon dont l'algorithme reconnaît les parois :

- **Ordre des murs : `Inner/Outer`.** C'est indispensable. L'algorithme se base sur cet ordre pour savoir quelle boucle est imbriquée dans quelle autre.
- **Générateur de murs : `Classic`.** `Arachne` produit parfois des boucles orphelines dont l'ordre n'est pas prévisible, ce qui donne des artefacts.
- **Désactiver `Arc fitting`.** Les parcours en arc de cercle ne sont pas gérés.
- **G-code binaire : désactivé.** PrusaSlicer peut produire du binaire, incompatible avec tout post-traitement (Printers → Général → Firmware).

### Options

| Option | Défaut | Rôle |
|---|---|---|
| Hauteur de couche | 0.2 mm | Doit correspondre au sliceur. Sert au décalage demi-couche. |
| Première couche traitée | 3 | Les premières couches restent intactes (adhérence au plateau). |
| Multiplicateur d'extrusion | 1.05 | +5 % sur les parois déplacées, pour éviter le sous-extrusion des zones en pente. |
| Aplatir la dernière couche | oui | Garde le sommet propre, sans demi-couche en débord. |

## Tester

```bash
node test/run.mjs              # assertions sur le fixture généré
node test/make-fixture.mjs     # régénère le fixture
python3 -m http.server 8734    # sert la page web sur cette adresse
```

Le dossier `test/golden/real_orca.gcode` est un vrai fichier slice (PrusaSlicer, 324 Ko, 75 couches) issu du dépôt de référence, utilisé pour vérifier le rendu en conditions réelles.

## Ce que ça ne fait pas

- Pas de prévisualisation dans le navigateur (le G-code n'est pas rendu en 2D).
- Pas de prise en charge des arcs (`G2`/`G3`), comme l'original.
- Les surfaces en pente peuvent légèrement sous-extruder, comme la méthode d'origine.

## Crédits

Portage JavaScript de [GeekDetour/BrickLayers](https://github.com/GeekDetour/BrickLayers) (GPL-3.0, Everson Siqueira), qui implémente la méthode décrite par Stefan Hermann / CNC Kitchen dans [Brick Layers](https://youtu.be/5hGm6cubFVs).

Le principe du décalage demi-couche est décrit depuis longtemps (brevet Batchelder US005653925A de 1995, EP0852760B1 de 1996).
