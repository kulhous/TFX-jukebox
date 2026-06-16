# TFX track names — canonical list & mapping status

## Sources
- **START.EXE LMEDIT Track Driver filename table** @ file offset 0x467e — the game's
  own song identifiers (DOS paths `tunes\<name>.{rld,scc,adl}`).
- **Full DID.DAT** — mission scripts contain `MUSIC PC PLAY <n>` cues, and the
  archive metadata/string area contains music resource path atoms such as
  `tunes\airsuper\`, `tunes\closeair\`, `tunes\defssupr\`, `tunes\intercep\`,
  `tunes\interdic\`, `tunes\maritime\`, `tunes\antiarm\`, plus `.adl/.rld/.scc`
  extension atoms. Each tune blob also has a 12-byte hash table record
  (`hash32, offset32, packed_size32`) in DID.DAT.
- **Barry Leitch official album** (composer), human-readable titles:
  https://barryleitch.bandcamp.com/album/tfx-tactical-fighter-experiment

## Canonical song identifiers → human name
| driver id (`tunes\…`) | human name (album) |
|---|---|
| intro    | Intro / Anarchy |
| inter    | Intermission |
| news     | News Briefing |
| enrol    | Enrolment / Training |
| death    | Death |
| columbia | Columbia |
| libya    | Libya |
| ocean    | Ocean Mission |
| somalia  | Somalia |
| yugo     | Yugoslavia |
| airsuper | Air Superiority Mission |
| closeair | Close Air Support Mission |
| defssupr | Defence Suppression Mission |
| intercep | Interception Mission |
| interdic | Interdiction Mission |
| maritime | Maritime Mission |
| antiarm  | Anti-Armour Mission |
| airbatle | The Battle |
| 1unsucc  | Unsuccessful Flight Home |
| 2succ    | Victorious Flight Home |
| 3-9tunes | Jingles (Close to Death / Winning / Parachute / Good Kill / Bad Kill / Wingman Down) |
| engine   | Engine (sfx) |
| fxonly   | FX only (no music) |

Game `MUSIC PC PLAY <n>` cues (in DID.DAT mission scripts) select among these,
within theatre worlds libya / somalia / yugoslavia / training.

## Mapping to extracted tune_NN files — STATUS: only INTRO confirmed
The 43 `tune_NN_at<off>_<DEV>` files were carved from TFX.DAT by offset; that order
does NOT match the driver table order, so names cannot be assigned positionally.
Confirmed by decompressed-size match to the known intro modules:
- `tune_36_at033dc87_RLD_dec41088` = **intro** (RLD)  (= intro_rld_module.bin, 41088 B)
- `tune_37_at0340858_SCC_dec35902` = **intro** (SCC)  (= intro_scc_module.bin, 35902 B)

To name the rest reliably: resolve the DID/TFX resource hash for each canonical
`tunes\<name>.<dev>` path, or locate the driver's PLAY-index → tune-offset table
(in TFX.DAT / the resident OSL driver). The DID metadata proves every extracted
tune offset is referenced, but the name-to-hash step is still custom/unknown, so
until that is decoded the player labels the unresolved files `Tune NN (DEV)`.
