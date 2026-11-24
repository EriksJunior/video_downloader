# Framegrab

Aplicacao Node.js local para analisar videos publicos do YouTube e TikTok, escolher a qualidade disponivel, recortar um intervalo opcional e salvar no destino escolhido pelo usuario. Cole o link do video na interface (incluindo links curtos do TikTok, como `https://vm.tiktok.com/...`). Quando o TikTok nao informar resolucoes, a opcao **Melhor qualidade disponivel** sera exibida.

O recorte aceita `MM:SS` ou `HH:MM:SS`. Deixe os campos de inicio e fim vazios para baixar o video completo.

Antes do primeiro download, a pasta de destino deve ser informada pela interface. Caminhos do Windows, como `C:\Users\seu-usuario\Videos`, sao convertidos automaticamente quando o servidor esta no WSL. A escolha fica salva em `.framegrab-settings.json` ate que seja alterada ou removida.

O botao **Escolher pasta** abre o seletor nativo do Windows quando o servidor esta no WSL. Se a integracao do Windows nao estiver disponivel, use **Digitar caminho**.

## Executar

Requisitos: Node.js 18 ou superior, Python 3.10 ou superior, FFmpeg e FFprobe no `PATH`.

Nos downloads do YouTube, o aplicativo prefere audio AAC. Se o arquivo vier com audio Opus, ele converte somente o audio para AAC antes de concluir o download, mantendo o video sem recodificacao. Arquivos ja baixados nao sao alterados automaticamente.

No Linux/WSL, prepare o ambiente Python do projeto para o yt-dlp conseguir acessar paginas de verificacao do TikTok (use Python 3.11 ou superior com `pip`):

```bash
python3.11 -m venv .venv
.venv/bin/python3 -m pip install curl-cffi
```

O servidor usa automaticamente `.venv/bin/python3` para o yt-dlp quando esse ambiente existe. Reinicie o servidor apos criar o ambiente. Sem ele, o yt-dlp continua usando o Python padrao do sistema. O acesso a videos tambem pode depender das restricoes do TikTok.

Se a analise informar que o TikTok bloqueou o acesso pela rede, a verificacao de navegador ja funcionou, mas aquele video nao pode ser acessado pelo IP atual. Experimente outro video publico ou outra rede.

```bash
npm install
npm start
```

Abra `http://127.0.0.1:3000` no navegador.

Os arquivos ficam na pasta configurada na interface.

## Instalador Windows 64 bits

O aplicativo Electron inclui Node.js, yt-dlp, FFmpeg e FFprobe no instalador. Quem instala nao precisa configurar WSL, Python ou essas ferramentas. Para gerar o instalador, use **Windows x64 com Node.js 22 ou superior** (nao gere o pacote Windows a partir do WSL):

```powershell
$env:YOUTUBE_DL_SKIP_PYTHON_CHECK = '1'
npm ci
npm run check
npm test
npm run dist:win
```

O arquivo final fica em `dist/Framegrab-Setup-1.0.0-x64.exe`. Alternativamente, no GitHub, abra **Actions > Instalador Windows > Run workflow** e baixe o artefato `Framegrab-Windows-x64` da execucao concluida.

O instalador cria atalhos e permite desinstalar em **Configuracoes > Aplicativos** do Windows. A desinstalacao nao apaga os videos salvos pelo usuario; as configuracoes ficam na pasta de dados do usuario (`%APPDATA%\Framegrab`) em vez da pasta de instalacao. Para abrir a versao Electron em desenvolvimento, use `npm run electron`.

O instalador gerado sem certificado digital pode exibir um aviso do Windows SmartScreen. Para distribuicao ampla, assine o executavel com um certificado de assinatura de codigo. Os programas de terceiros incluidos no instalador possuem licencas proprias; confira-as antes de redistribuir.

Para usar outra porta:

```bash
PORT=4000 npm start
```

Use a aplicacao somente para baixar conteudo proprio, de dominio publico ou para o qual voce tenha permissao. A disponibilidade de formatos depende do site e do video.
