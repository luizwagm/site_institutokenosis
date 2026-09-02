# Instituto Kenósis — site + gerenciador

Site institucional da OSC Instituto Kenósis Fonte das Graças Conceição & Menezes
(Caruaru-PE), com painel próprio para o cliente editar **todo** o conteúdo.

- **Domínio:** institutokenosis.com
- **Porta interna:** 5189 · **Serviço:** `kenosis.service`
- **Stack:** Node puro (`node:http` + `node:sqlite`) — **zero dependências**.
  Exige **Node ≥ 22.5** (é a versão que traz `node:sqlite`).

## Como funciona

O banco `data/site.db` é a fonte da verdade do conteúdo. O botão **Publicar**
do painel regenera os arquivos HTML estáticos a partir dele: o visitante recebe
sempre HTML pronto, com o SEO já embutido — não há renderização por requisição.

- Textos ficam entre marcadores `<!--#CHAVE-->…<!--/CHAVE-->` no `index.html`.
- As demais páginas saem dos moldes em `src/*.html`, com `{{PLACEHOLDER}}`.
- A declaração `CAMPOS`, no `server.js`, é o que monta a interface do painel.
  Campo novo = uma linha ali; o painel se ajusta sozinho.

Para republicar sem abrir o painel (útil em script):

```bash
node server.js --publicar
```

## Subir em produção — na ordem

**São DOIS bancos**, de propósito: o site e o `/admin` vivem no SQLite
(`data/site.db`), e o sistema de gestão `/restrito` vive no **PostgreSQL**, que
guarda dado pessoal sensível — CPF, endereço e prontuário — cifrado. Os passos
abaixo montam os dois. Pular a parte do Postgres deixa o site no ar e o
`/restrito` fora (é assim por desenho: uma falha no banco da gestão não derruba
o site do instituto).

Pré-requisitos: Node ≥ 22.5, nginx, certbot, PostgreSQL e o repositório clonado
em `/var/www/projetos/Instituto-Kenosis`.

```bash
# 0. pacotes do sistema
#    postgresql-client é obrigatório: é dele que vem o pg_dump, usado pelo
#    backup diário e pelo botão "Backup do banco" do menu.
sudo apt update
sudo apt install -y postgresql postgresql-client nginx certbot python3-certbot-nginx

# 1. dependências do Node
#    Sem o pacote `pg` o /restrito não conecta. O site continua no ar, mas a
#    gestão responde 503 até isto rodar.
cd /var/www/projetos/Instituto-Kenosis
npm ci --omit=dev
```

```bash
# 2. banco e usuário do PostgreSQL
#    A senha vai para o /etc/kenosis.env no passo seguinte — gere uma forte e
#    NÃO reaproveite a de outro projeto do servidor.
SENHA=$(openssl rand -base64 24)
sudo -u postgres psql -c "CREATE USER kenosis WITH PASSWORD '$SENHA';"
sudo -u postgres psql -c "CREATE DATABASE kenosis_gestao OWNER kenosis;"
echo "guarde esta senha: $SENHA"
```

```bash
# 3. credenciais + a chave que cifra os dados dos beneficiários
#    PERDER A DADOS_CHAVE TORNA CPF, ENDEREÇO E PRONTUÁRIO ILEGÍVEIS PARA
#    SEMPRE — nem o backup salva, porque o backup também está cifrado.
#    Guarde uma cópia FORA do servidor antes de cadastrar o primeiro usuário.
sudo tee /etc/kenosis.env >/dev/null <<EOF
PGHOST=127.0.0.1
PGPORT=5432
PGUSER=kenosis
PGPASSWORD=$SENHA
PGDATABASE=kenosis_gestao
DADOS_CHAVE=$(openssl rand -base64 32)
EOF
sudo chown root:deploy /etc/kenosis.env
sudo chmod 640 /etc/kenosis.env          # só o root escreve; o serviço lê
```

```bash
# 4. estrutura do banco da gestão
#    O boot do serviço também aplica sozinho, mas rodar aqui é melhor: um erro
#    de migração aparece agora, e não num serviço que não sobe.
node migrar.js
node migrar.js --status                  # confere o que foi aplicado
```

```bash
# 5. serviço do systemd (confira User, WorkingDirectory e o caminho do node)
sudo cp nginx/kenosis.service /etc/systemd/system/kenosis.service
sudo systemctl daemon-reload
sudo systemctl enable --now kenosis.service
sudo systemctl status kenosis.service

# 6. permissão de escrita — o SQLite grava um -journal DENTRO de data/,
#    então a pasta precisa ser gravável, não só o arquivo
sudo chown -R deploy: data assets/img/uploads restrito/arquivos backups

# 7. conteúdo original — RODE UMA VEZ SÓ, e só depois que o passo 5 subiu
#    (é o boot do server.js que cria as tabelas; antes disso o script para
#     com um aviso em vez de deixar um banco pela metade)
systemctl is-active kenosis.service     # tem de responder: active
node aplicar-original.js
sudo systemctl restart kenosis.service

# 8. vhost do nginx + certificado (o DNS já precisa apontar para cá)
sudo ./nginx/criar-site.sh institutokenosis.com 5189 contato@institutokenosis.com

# 9. conferir tudo
./verificar.sh
journalctl -u kenosis -n 30 --no-pager | grep -i "gestão"
```

O log do boot tem de dizer `Banco da gestão: PostgreSQL — kenosis_gestao`. Se
disser `✖ INDISPONÍVEL`, o site está no ar mas o `/restrito` não: o próprio log
lista o que conferir (serviço do Postgres, credenciais, existência do banco).

### Primeiro acesso

| Onde | Login | Senha inicial |
|---|---|---|
| `/admin` (painel do site) | — | `kenosis-admin` |
| `/restrito` (gestão) | `admin` | `kenosis-gestao` |

**Troque as duas no primeiro acesso.** O `verificar.sh` avisa enquanto forem as
iniciais. A senha da gestão se troca em *Minha conta*.

### Sobre o banco na primeira subida

O `data/site.db` **não vai pelo git** — é o conteúdo vivo do site e versioná-lo
significaria publicar o hash da senha no repositório e deixar um `git pull`
sobrescrever o que o cliente editou. Ele nasce no servidor, em dois tempos:

1. **primeiro boot** — o `server.js` cria as tabelas e semeia os padrões
   (7 pessoas na diretoria, 3 projetos, os textos das seções). A senha inicial
   do painel é `kenosis-admin`, avisada no log.
2. **`aplicar-original.js`** — grava o conteúdo real vindo do site antigo:
   32 serviços em 3 categorias, 8 documentos com os links do Drive e o texto
   integral de cada projeto e página. Ele lê o `conteudo-original.json`, que
   **está** no repositório.

Testado: clone limpo + esses dois passos produz um banco idêntico ao de
desenvolvimento (118 textos, mesmas contagens) e os mesmos arquivos HTML.

O script é destrutivo por natureza (apaga e regrava serviços e documentos), por
isso ele se recusa a rodar duas vezes. Se um dia precisar mesmo repetir, use
`--forcar` — e faça backup do banco antes.

**Alternativa:** se preferir subir o banco já pronto do seu computador, copie-o
com o serviço parado e ajuste o dono:

```bash
sudo systemctl stop kenosis.service
scp data/site.db deploy@SERVIDOR:/var/www/projetos/Instituto-Kenosis/data/site.db
sudo chown deploy: data/site.db && sudo systemctl start kenosis.service
```

Nesse caminho a senha do painel será a que estiver no seu banco local — não a
padrão.

O `criar-site.sh` já deixa configurado:

- `client_max_body_size 25m` — o painel envia foto em base64; o padrão de 1 MB
  devolveria 413.
- `X-Forwarded-For` e `X-Forwarded-Proto` — sem eles o contador vê um único
  visitante e o cookie de sessão perde o `Secure`.
- `error_page 502 503 504 /manutencao.html` — a tela de manutenção aparece
  mesmo com a aplicação fora do ar.

**Troque a senha do painel no primeiro acesso.** O `verificar.sh` avisa
enquanto ela continuar sendo a inicial.

## Atualizar depois

```bash
./verificar.sh          # como está a produção agora
sudo ./deploy.sh        # backup → parar → proteger o banco → pull → subir → conferir
```

**Nunca use `git pull` direto.** O banco é ignorado pelo git (`.gitignore`), e
um pull que traga um commit onde o arquivo não existe **apaga o banco**. O
`deploy.sh` tira o banco do diretório antes do pull e o devolve depois; se algo
falhar no caminho, ele restaura sozinho e sobe o serviço de volta.

Depois de mexer no `server.js`, o Node **precisa** reiniciar — o `deploy.sh`
faz isso. Um pull sem restart deixa o código novo em disco e o antigo na
memória (foi assim que `{{APP_VERSION}}` apareceu cru em produção uma vez).

## Sistema de gestão — /restrito

Aplicação **independente** do painel do site, para a operação interna da ONG
(pacientes, atendimentos, prontuário, associados, benefícios, eventos). Fica em
`https://institutokenosis.com/restrito/`, com link discreto no rodapé do site.

- **Código:** `restrito.js` + `restrito/app.html` — não se mistura com `server.js`/`admin`.
- **Banco próprio: PostgreSQL** (`kenosis_gestao`), nunca o `site.db`. Guarda
  dado pessoal sensível — CPF, endereço, anamnese e prontuário ficam **cifrados
  na coluna**, com a chave em `DADOS_CHAVE`, fora do git e fora do banco. Os
  arquivos de pacientes ficam em `restrito/arquivos/` (também fora do git).
  O esquema é aplicado sozinho no boot, a partir de `migrations/*.sql`.
- **Login próprio:** cookie de sessão `rid`, separado do `sid` do admin. Uma
  sessão não abre o outro sistema. Senha inicial: `admin` / `kenosis-gestao`
  (troque em Minha conta; o `verificar.sh` avisa enquanto for a padrão).
- Compartilha só o processo Node e a porta — nada a mexer no nginx.

Módulos (todos ativos): **Pacientes, Associados, Profissionais, Agenda,
Prontuário, Benefícios, Eventos, Documentos e Relatórios**. Os formulários
têm máscara e validação de CPF (com dígito verificador), telefone, e-mail,
NIS e Cartão SUS; a agenda e o prontuário referenciam paciente/profissional
por seleção. Relatórios trazem indicadores, gráficos e exportação CSV.

### No celular

O `/restrito` e o `/admin` funcionam inteiros no telefone — é de lá que a
equipe técnica lança o atendimento na sala e fecha a frequência na beira da
piscina. Abaixo de 860px o menu lateral vira **gaveta** (o botão de três
traços, no canto de cima); as tabelas rolam para o lado **dentro do cartão**,
com a coluna de ações presa na borda direita; os formulários viram folha que
sobe do rodapé, com o Salvar grudado no pé da tela; e todo campo tem 16px, o
mínimo que impede o iPhone de ampliar a página sozinho quando o dedo entra no
campo — e não voltar mais.

## Tela de manutenção — duas camadas

| Situação | Quem responde |
|---|---|
| App no ar, manutenção ligada no painel | o próprio app, em todas as rotas menos `/admin/` |
| App fora do ar (restart, deploy, queda) | o nginx, servindo `manutencao.html` do disco |

Ligar/desligar: painel → **Publicar** → *Tirar o site do ar*. O título e o texto
da tela são editáveis ali mesmo.

## Estrutura

```
server.js          aplicação: site, painel, API e publicação
admin/             painel (HTML único, sem build)
index.html         home — os textos vivem entre marcadores
src/*.html         moldes das páginas internas
assets/            css, js, imagens (uploads/ fica só no servidor)
data/site.db       conteúdo do site — NÃO versionado, NÃO perder
deploy.sh          atualização segura em produção
verificar.sh       diagnóstico, só leitura
nginx/criar-site.sh   vhost + certificado
nginx/kenosis.service unit do systemd
importar.js        baixa o conteúdo do site antigo (Google Sites)
aplicar-original.js grava no banco o texto original, sem paráfrase
testar-*.js        as provas (veja abaixo)
```

### As provas

Cada uma sobe uma cópia do site numa porta própria e derruba no fim.

| Comando | O que guarda |
|---|---|
| `node testar-cabecalhos.js` | os cabeçalhos que o navegador obedece — inclusive a `Permissions-Policy` aberta no `/restrito`, sem a qual a câmera da reunião é recusada em silêncio |
| `node testar-texto.js` | o texto do painel chega à tela sem tag e sem `&nbsp;` |
| `node testar-limitador.js` | a trava de tentativas de senha |
| `node testar-frequencia.js` | o título e o local da folha de frequência, e o 503 (nunca 500) enquanto a gestão está subindo |

> `testar-frequencia.js` é a única que fala com o **PostgreSQL de verdade** —
> não existe banco descartável para ele. Ela só cria registros próprios,
> marcados `ZZ QA`, e os apaga **pelo id** no fim. Interrompida no meio, ela
> imprime os ids que sobraram.

## Backup

O `deploy.sh` guarda em `backups/` (20 mais recentes) a cada execução. Para um
backup manual:

```bash
cp data/site.db ~/site-$(date +%F-%H%M).db
```
