# Lumi AI

Il piccolo server tra la chat di Lumi sul sito e Claude (Anthropic).

- `src/rules.js`: chi è Lumi, cosa può dire, cosa non deve fare mai.
- `src/index.js`: riceve le domande dal sito, aggiunge regole e catalogo, chiama Claude, applica i limiti.
- Ogni notte ricostruisce il catalogo da `iluminari3d.com/products.json`.
- Limiti: 40 messaggi al giorno per visitatore, 1500 al giorno per tutto il sito (modificabili in `wrangler.toml`).
- La chiave API è un secret di Cloudflare (`ANTHROPIC_API_KEY`), mai nel codice.
- Salute: `GET /health`.
