# Pluto TV Brasil → M3U para SS IPTV

Gera uma lista M3U com os **filmes sob demanda** do Pluto TV Brasil (https://pluto.tv/br/movies/),
organizada por categorias, otimizada para o **SS IPTV**, atualizada **a cada 6 horas** pelo GitHub Actions.

## Como funciona

```
GitHub Actions (6/6h) ──► API da Pluto (categorias + "carregar mais" até acabar)
        │                       │
        │                 state.json (mantém ativos, remove inativos, soma novos)
        ▼
playlist/pluto-br-filmes.m3u  ──►  SS IPTV
   links CURTOS: https://SEU-WORKER/play/<id>.m3u8
                                  │ (no momento do play)
                                  ▼
                    Cloudflare Worker: cria sessão/JWT novo, busca o HLS
                    na Pluto e devolve o manifesto  ──►  player
```

**O problema dos links longos:** o link real da Pluto carrega um JWT enorme que expira em minutos.
Na M3U vai só um link curto; o Worker gera o link longo *na hora de assistir* (conteúdo sob demanda),
então ele nunca expira e o SS IPTV só vê uma URL pequena.

### Formato da lista (SS IPTV)
```
#EXTM3U
#EXTSIZE:medium
#EXTINF:-1 tvg-id="<id>" tvg-logo="<capa>" group-title="<Categoria>" content-type="video",Título
https://SEU-WORKER/play/<id>.m3u8
```
- `content-type="video"` → barra de progresso. 
- `#EXTSIZE:medium` (antes de cada título) → botões médios. (A grafia correta da tag é `medium`.)

### Regras de atualização
- Título presente na Pluto → **mantido** (metadados atualizados).
- Título novo → **adicionado**.
- Título ausente → só é **removido após 2 execuções seguidas** (`graceRuns`), para uma falha momentânea da API não apagar nada.
- Se o catálogo novo vier com menos de 50% do anterior (`minKeepRatio`) ou vazio, a atualização é **abortada** e a lista anterior permanece.
- A paginação ("carregar mais") é feita pela mesma API que o site usa, página a página, até não vir mais itens.

## Instalação (passo a passo)

1. **Fork/crie o repositório** e envie estes arquivos.
2. **Cloudflare Worker** (gratuito, 100 mil acessos/dia):
   - Crie um token em Cloudflare → *My Profile → API Tokens → "Edit Cloudflare Workers"*.
   - No GitHub: *Settings → Secrets and variables → Actions → Secrets*: `CLOUDFLARE_API_TOKEN` e `CLOUDFLARE_ACCOUNT_ID`.
   - Rode o workflow **Publicar Worker (Cloudflare)** (aba Actions). Anote a URL `https://pluto-br-ssiptv.<conta>.workers.dev`.
3. No GitHub: *Settings → Secrets and variables → Actions → **Variables***: crie `RESOLVER_BASE_URL` com a URL do Worker (sem `/` no final).
4. **Região Brasil (importante):** os runners do GitHub ficam nos EUA e a Pluto filtra o catálogo por IP.
   Se o job falhar com `país "US"`, coloque um IP brasileiro em `forwardedForIp` no `config.json`
   (e, se necessário, em `FORWARDED_FOR_IP` no `worker/wrangler.toml`), ou use um *self-hosted runner* no Brasil.
5. Rode o workflow **Atualizar lista M3U** manualmente uma vez (aba Actions → Run workflow).
6. No SS IPTV, adicione a lista:
   `https://raw.githubusercontent.com/SEU-USUARIO/SEU-REPO/main/playlist/pluto-br-filmes.m3u`

## Configuração (`config.json`)
| chave | função |
|---|---|
| `includeSeries` | `true` inclui episódios das séries (a lista fica bem maior) |
| `excludeCategories` | categorias a ignorar |
| `forwardedForIp` | IP BR para a sessão da Pluto |
| `graceRuns` / `minKeepRatio` | tolerância antes de remover / proteção contra catálogo incompleto |
| `ssiptv.extSize` / `ssiptv.contentType` | tags do SS IPTV |
| `verify.sample` / `verify.minSuccess` | quantos links testar por execução / taxa mínima de sucesso |

## Testes
- `npm test` — 8 testes automáticos, **sem internet**, com um servidor Pluto simulado: coleta paginada,
  formato da M3U, regras de manter/remover/adicionar, Worker, e reprodução ponta a ponta
  (manifesto → variante → 1º segmento de vídeo).
- `npm run verify -- --sample=30` (ou `--all`) — testa **links reais** pelo Worker. Roda no workflow antes de publicar:
  se menos de 80% tocarem, o commit não acontece e a lista anterior continua no ar.
- `npm run probe` — mostra o formato real das respostas da Pluto (diagnóstico se a API mudar).

## Limitações
- A API da Pluto não é pública/documentada e pode mudar; por isso existem o `probe`, a proteção de catálogo e os testes.
- Conteúdo geoblocado: só toca se a Pluto aceitar a origem como Brasil.
- Com `serverSideAds=false` a sessão pede o stream sem anúncios injetados; a Pluto pode inserir anúncios mesmo assim.
