# Stage Prompt — Central Local (app desktop)

Este pacote transforma a **Central Local** (`local-hub/`) do projeto Stage Prompt
num app desktop de verdade, com ícone e janela próprios, em vez de rodar via
`start-windows.bat` / `start-mac-linux.command` exigindo Node.js instalado.

Ao abrir o app, ele já sobe sozinho (embutido no processo do Electron):
- HTTP na porta **8787** (telão, cronômetro, recados, QR code)
- HTTPS na porta **8788** (voz ao vivo / microfone)

Os outros aparelhos (celular, tablet, telão) continuam conectando pelo
Wi-Fi local, exatamente como antes — só o computador principal ganhou um
app de verdade em vez de um script.

## O que já está pronto

- `dist/Stage Prompt - Central Local Setup 1.0.0.exe` — instalador **Windows**,
  gerado e testado aqui (NSIS, 64 bits).
- `.github/workflows/build.yml` — workflow do GitHub Actions que gera o
  **.dmg do Mac** (e também pode regerar o `.exe`) em runners reais da Microsoft
  e da Apple. Um `.dmg` de verdade só pode ser gerado num Mac (a ferramenta
  `hdiutil` é exclusiva do macOS) — por isso o Mac é buildado na nuvem, não
  neste ambiente.

## Como gerar o instalador do Mac (.dmg)

1. Crie um repositório no GitHub e suba esta pasta inteira (`git init`,
   `git add .`, `git commit`, `git push`).
2. Na aba **Actions** do repositório, rode o workflow **Build installers**
   manualmente ("Run workflow"), ou crie uma tag `v1.0.0` e dê `git push --tags`.
3. Quando terminar, baixe o artefato **mac-installer** (contém o `.dmg`) e
   **windows-installer** (contém o `.exe`, caso queira gerar de novo lá).

## Rodando localmente (dev)

```sh
npm install
npm start
```

## Gerando os instaladores você mesmo

```sh
npm run dist:win   # gera o .exe (no Linux, precisa de wine + wine32 instalados)
npm run dist:mac   # só funciona rodando num Mac
```

## Aviso importante: SmartScreen e Gatekeeper

Como o app **não tem certificado de assinatura de código** (esses
certificados são pagos — nas centenas de dólares por ano), tanto Windows
quanto Mac vão mostrar um aviso na primeira execução. Isso é normal para
programas independentes e não indica vírus:

- **Windows**: aparece "O Windows protegeu o computador". Clique em
  **Mais informações** → **Executar assim mesmo**.
- **Mac**: aparece que o app é de "desenvolvedor não identificado". Clique
  com o botão direito no app → **Abrir** → confirme **Abrir** (só precisa
  fazer isso na primeira vez).

Se no futuro quiser eliminar esses avisos, é possível comprar um certificado
de assinatura (Apple Developer Program, ~US$99/ano, e um certificado de
assinatura de código Windows) e configurar no `package.json` (`build.mac.identity`
e `build.win.certificateFile`) — posso te ajudar com isso quando tiver os
certificados em mãos.

## Estrutura

- `main.js` — processo principal do Electron: sobe o servidor da Central
  Local embutido (sem precisar de Node.js instalado na máquina do usuário)
  e abre a janela apontando para `http://localhost:8787`.
- `local-hub/` — cópia do servidor local-hub original (`server.mjs` +
  `public/` + `certs/`), com um pequeno ajuste: a pasta onde ele salva o
  estado das salas (`stage-hub-state.json`) agora usa a pasta de dados do
  usuário (gravável), em vez de tentar escrever dentro da própria instalação
  do app (que no Mac e em instalações "para todos os usuários" do Windows é
  somente leitura).
- `build/` — ícones gerados a partir de `public/stage-prompt-icon-512.png`
  do projeto original.
