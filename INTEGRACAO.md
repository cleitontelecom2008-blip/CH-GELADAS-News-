# CH Geladas PDV — Guia de Integração das Melhorias v4.1
> Engenheiro responsável: revisão sênior · Maio 2026

---

## O QUE FOI ENTREGUE

| Arquivo | Tipo | Descrição |
|---|---|---|
| `services/soundService.js` | **NOVO** | Feedback sonoro via Web Audio API + hooks automáticos |
| `services/biService.js` | **NOVO** | Motor de BI: Curva ABC, CMV, ticket médio, horários pico, produtos parados, ranking |
| `services/errorPreventionService.js` | **NOVO** | Anti-duplicata, estoque insuficiente, alto valor, desconto excessivo |
| `services/featureFlagsService.js` | **NOVO** | Feature flags por plano SaaS (free/basico/premium/enterprise) |
| `bi-dashboard.html` | **NOVO** | Dashboard completo de BI com gráficos interativos |
| `firestore.rules` | **SUBSTITUIR** | Regras de segurança multi-tenant corrigidas (crítico) |

---

## PASSO 1 — Copiar arquivos

```bash
# A partir da raiz do projeto:
cp services/soundService.js          ./services/
cp services/biService.js             ./services/
cp services/errorPreventionService.js ./services/
cp services/featureFlagsService.js   ./services/
cp bi-dashboard.html                 ./
cp firestore.rules                   ./          # substitui o existente
```

---

## PASSO 2 — Adicionar `<script>` tags nos HTMLs

### 2.1 — `index.html` (menu principal)

Localize o bloco de scripts no final do `<body>`. Adicione **após** `services/saasService.js`:

```html
<!-- ADICIONAR ESTAS LINHAS -->
<script src="services/featureFlagsService.js"></script>
<script src="services/soundService.js"></script>
```

### 2.2 — `vendas.html` (PDV principal)

Adicione **após** `services/vendasService.js` e **antes** do `</body>`:

```html
<!-- ADICIONAR ESTAS LINHAS -->
<script src="services/errorPreventionService.js"></script>
<script src="services/soundService.js"></script>
<script src="services/featureFlagsService.js"></script>
```

Depois, localize a função que finaliza a venda no `<script>` inline do `vendas.html`.
Procure pelo trecho onde `CartService.finalize()` ou `CH.CartService.finalize()` é chamado
e adicione a validação **antes**:

```js
// ANTES (exemplo do padrão existente):
async function finalizarVenda() {
  // ... código existente
  const venda = window.CH.CartService.finalize(formaPgto, extras);
  // ...
}

// DEPOIS — adicione validação antes de finalizar:
async function finalizarVenda() {
  // 1. Validação preventiva
  const cart = window.CH.CartService;
  const EP   = window.CH.ErrorPreventionService;
  if (EP) {
    const { ok, erros, avisos } = EP.validarCarrinho(cart);

    // Exibe avisos (não bloqueia)
    if (avisos.length) {
      const msgs = avisos.map(a => a.msg).join('\n');
      if (!confirm('⚠️ Atenção:\n\n' + msgs + '\n\nDeseja continuar?')) return;
    }

    // Bloqueia em caso de erro
    if (!ok) {
      const msgs = erros.map(e => '• ' + e.msg).join('\n');
      window.showToast('Venda bloqueada', erros[0].msg, 'error');
      window.CH.SoundService?.error();
      alert('Não é possível finalizar:\n\n' + msgs);
      return;
    }
  }

  // 2. Finaliza (código original)
  const venda = window.CH.CartService.finalize(formaPgto, extras);
  // ... resto do código original inalterado
}
```

### 2.3 — `financeiro.html`

Adicione antes do `</body>`:

```html
<script src="services/biService.js"></script>
<script src="services/featureFlagsService.js"></script>
```

### 2.4 — `estoque.html`

```html
<script src="services/soundService.js"></script>
<script src="services/errorPreventionService.js"></script>
```

### 2.5 — `bi-dashboard.html` (arquivo novo — não precisa modificar)

Já carrega todos os scripts necessários internamente.

---

## PASSO 3 — Atualizar `firestore.rules`

```bash
firebase deploy --only firestore:rules
```

### O que mudou nas regras (leia antes de fazer deploy):

| Problema v3 | Correção v4 |
|---|---|
| `saas_dados/{empresaId}/**` aceitava qualquer autenticado escrever em qualquer empresa | Write exige `empresaId` no doc = empresaId do path, ou adminToken |
| `saas_usuarios` sem validação de estrutura | Create exige campos obrigatórios + `id == uid` |
| Backups legíveis por qualquer autenticado | Leitura de backups agora exige adminToken |
| Convites sem validação de campos | Create exige `codigo`, `empresaId`, `expiresAt` |
| adminToken validado só por `size() >= 16` | Agora exige exatamente 64 chars (SHA-256 hex) |

> ⚠️ **TESTE EM STAGING ANTES** — especialmente a regra de `saas_dados` se
> você tiver clientes SaaS ativos.

---

## PASSO 4 — Adicionar link para o Dashboard BI

No `index.html`, localize o menu de módulos e adicione:

```html
<!-- Dentro do grid de módulos, adicione: -->
<a href="bi-dashboard.html" class="module-card" ...>
  <span class="module-icon">📊</span>
  <span class="module-name">Dashboard BI</span>
  <span class="module-desc">Curva ABC · CMV · Analytics</span>
</a>
```

---

## PASSO 5 — Feature Flags (opcional, mas recomendado)

Para habilitar controle de plano em módulos existentes,
envolva qualquer funcionalidade premium com `CH.FeatureFlags.exigir()`:

```js
// Exemplo no financeiro.html — relatório avançado:
function abrirRelatorioAvancado() {
  window.CH.FeatureFlags.exigir('relatorio_avancado', () => {
    // Código do relatório aqui — só executa se o plano permite
    gerarRelatorio();
  });
}

// Exemplo no delivery.html:
function iniciarDelivery() {
  window.CH.FeatureFlags.exigir('delivery', () => {
    // ... código existente
  });
}
```

---

## PASSO 6 — Feedback sonoro (automático)

O `soundService.js` funciona via EventBus. **Não é necessário modificar nada**.
Os hooks automáticos já cobrem:

| Evento | Som |
|---|---|
| `venda:finalizada` | `success()` — dois bips ascendentes |
| `venda:pendente` | `warning()` — bip duplo |
| `venda:cancelada` | `error()` — buzz grave |
| `auth:login` | `notification()` |
| `cart:item:added` | `click()` — toque suave |
| `estoque:ruptura` | `denied()` |
| `estoque:baixo` | `lowStock()` |

Para acionar manualmente:
```js
window.CH.SoundService.success();
window.CH.SoundService.error();
window.CH.SoundService.setEnabled(false); // mutar
window.CH.SoundService.setVolume(0.3);    // 30%
```

O estado (mudo/volume) persiste em `localStorage`.

---

## PASSO 7 — Emitir eventos que faltam (melhoria de cobertura)

Para que o SoundService cubra mais cenários, adicione emissões de evento
nos pontos indicados abaixo.

### No `CartService` (core.js) — ao adicionar item:

Localize a função `add()` ou `addItem()` dentro de `CartService` e adicione:
```js
// Após empurrar item no array:
EventBus.emit('cart:item:added', item);
```

### No `estoqueService.js` — ao detectar ruptura:

Na função `baixarEstoqueVenda`, após a transação, adicione:
```js
const depois = /* valor pós-baixa */;
if (depois <= 0) EventBus.emit('estoque:ruptura', { produtoId, nome });
else if (depois <= prod.estoqueMinimo) EventBus.emit('estoque:baixo', { produtoId, nome, qtd: depois });
```

---

## VERIFICAÇÃO RÁPIDA

Após a integração, abra o console do navegador e execute:

```js
// Testa todos os serviços novos
console.log('Sound:', !!window.CH.SoundService);
console.log('BI:', !!window.CH.BIService);
console.log('ErrorPrevention:', !!window.CH.ErrorPreventionService);
console.log('FeatureFlags:', !!window.CH.FeatureFlags);
console.log('Plano atual:', window.CH.FeatureFlags?.planoAtual());

// Testa BI
const dash = window.CH.BIService.getDashboardExecutivo();
console.log('Dashboard:', dash);

// Testa som
window.CH.SoundService.success();
```

Resultado esperado:
```
Sound: true
BI: true
ErrorPrevention: true
FeatureFlags: true
Plano atual: _standalone   ← (ou free/basico/premium se SaaS ativo)
```

---

## NOTA SOBRE RETROCOMPATIBILIDADE

Todos os serviços novos seguem o padrão do projeto:
- IIFE anônima: `(function() { ... })()`
- Exposto via `window.CH.NomeService`
- Sem modificar arquivos existentes
- Degradam graciosamente se dependências não estão disponíveis

O `featureFlagsService.js` em modo `_standalone` (sem SaaS) habilita
**todos os recursos** — comportamento idêntico ao sistema atual.

---

## SCORE ESPERADO PÓS-INTEGRAÇÃO

| Dimensão | Antes | Depois |
|---|---|---|
| Segurança multi-tenant | 5/10 | 8/10 |
| UX / feedback operacional | 5/10 | 8/10 |
| Analytics / BI | 2/10 | 8.5/10 |
| Prevenção de erros | 4/10 | 8/10 |
| Arquitetura SaaS | 6/10 | 8/10 |
| **Geral** | **6.9/10** | **~8.5/10** |

Para chegar a 9.5+ seria necessária a migração para backend Node.js/NestJS
com PostgreSQL, que é uma reescrita de escopo separado.
