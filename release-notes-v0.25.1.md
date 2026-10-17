# OpenDesign X v0.25.1

> **Corrigido (17/10 19:10):** a primeira publicação embutia um caminho da máquina de build no instalador, o que impedia o app de iniciar (instala porém não inicia). Reinstale esta versão atualizada — o instalador foi refeito no modo portable, e dois defeitos internos do arranque empacotado também foram corrigidos: a resolução de módulos no bundle CJS que parava antes de qualquer janela, e a resolução do ícone/preload que deixava o processo rodando sem abrir a janela (%APPDATA%\OpenDesign X).
Primeira entrega pública do **OpenDesign X** — reconstrução e evolução do OpenDesign (fork de github.com/nexu-io/open-design, Apache-2.0) como um aplicativo Windows próprio, com identidade, ícone e diretórios totalmente próprios: nunca sobrescreve a instalação original do OpenDesign.

## O que vem neste instalador

- **Instalador NSIS Windows x64** (`OpenDesign X-rg-setup.exe`) — instala em `%LOCALAPPDATA%\Programs`, cria atalho `OpenDesign X` no Menu Iniciar, entrada própria `OpenDesign X` em Apps & Recursos, e desinstalação limpa.
- **Interface reformulada**: onboarding, home, Studio, dark mode real e completo (verificado elemento a elemento) + preferência de tema claro/escuro/sistema, pt-BR padrão e inglês.
- **Assistente "Adicionar modelo ou provedor"** em 3 caminhos: DeepSeek/OpenAI/Anthropic/Gemini/OpenRouter/xAI/Groq/Together/Fireworks/Azure, endpoint compatível com OpenAI, ou provedores locais (Ollama/LM Studio/vLLM); descoberta de modelos, validação de conexão, chave guardada com segurança.
- **Backend preservado e expandido**: daemon SQLite local, agentes (AMR/Claude/Codex/OpenCode/hermes/BYOK), histórico de versões de arquivos com restauração, gerenciamento de projetos, terminais por projeto, automações com agendamento, CLI `od` com dual-track completo.
- **Ícone próprio** gerado programaticamente (tile escuro com monograma X em dois tons), títulos de janela `OpenDesign X`, pipes nomeados `opendesign-x-sidecar-*` para convivência pacífica com o app original.

## Requisitos

- Windows 10/11 x64
- Nenhuma credencial para instalar; para gerar artefatos por IA basta configurar um provedor no assistente (por exemplo, uma chave DeepSeek em Configurações → Modelos).

## Verificação

A cadeia completa de validação (typecheck, guard, suítes focais, 12 fluxos de usuário executados contra o daemon real) está documentada no README do repositório. O smoke de instalação em desktop é o último passo humano pendente.

- Registro: após instalar, `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\OpenDesign X-rg`
- Dados: `%APPDATA%\OpenDesign X\namespaces\rg` (isolados por namespace)

Aviso: fork independente mantido por Pepeu2010; sem afiliação com o projeto OpenDesign original. Código-fonte completo no repositório.

## Capturas de tela

| Home (claro) | Home (escuro) |
|---|---|
| ![Home claro](https://github.com/Pepeu2010/opendesign-x/raw/main/docs/screenshots/01-entry.png) | ![Home escuro](https://github.com/Pepeu2010/opendesign-x/raw/main/docs/screenshots/theme-dark-entry.png) |

| Workspace (escuro) | Assistente de provedor | Lista de modelos |
|---|---|---|
| ![Workspace](https://github.com/Pepeu2010/opendesign-x/raw/main/docs/screenshots/workspace-dark-project.png) | ![Wizard](https://github.com/Pepeu2010/opendesign-x/raw/main/docs/screenshots/wizard-step2-known.png) | ![Modelos](https://github.com/Pepeu2010/opendesign-x/raw/main/docs/screenshots/14-provider-list.png) |
