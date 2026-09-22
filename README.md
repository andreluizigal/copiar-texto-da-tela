# Copiar Texto da Tela

Extensão para o Google Chrome que permite selecionar uma área da página e copiar o texto dela,
inclusive texto dentro de imagens, vídeos pausados e PDFs. É uma alternativa leve ao Google Lens:
não abre painel lateral, não pesquisa nada no Google e não envia a imagem para nenhum servidor.
O reconhecimento (OCR) roda no próprio computador.

## Instalação

1. Abra `chrome://extensions` no Chrome.
2. Ative o **Modo do desenvolvedor** (canto superior direito).
3. Clique em **Carregar sem compactação** e escolha esta pasta (`copiar-texto-da-tela`).
4. (Opcional) Fixe o ícone da extensão na barra de ferramentas.

## Como usar

1. Clique com o **botão direito** em qualquer lugar da página e escolha
   **Copiar texto de uma área da tela**.
2. Arraste o mouse para selecionar a área que contém o texto. `Esc` ou o botão direito cancelam.
3. Pronto: o texto já vai para a área de transferência. Um aviso no canto da tela mostra o texto
   reconhecido; dá para corrigir alguma letra ali e clicar em **Copiar** de novo.

Também dá para iniciar a seleção clicando no ícone da extensão ou com o atalho **Alt+Shift+O**
(pode ser trocado em `chrome://extensions/shortcuts`).

### Texto inclinado, vertical ou de cabeça para baixo

Não precisa fazer nada de diferente: a extensão identifica a inclinação das linhas de texto
(qualquer ângulo) e endireita a imagem antes de ler. Se a leitura sair com pouca confiança,
ela testa sozinha as outras orientações (de cabeça para baixo, 90° e 270°) e fica com a melhor.
Texto reto é lido de primeira; texto de cabeça para baixo ou na vertical pode levar cerca de
1 segundo a mais.

## Desempenho e memória

- O OCR começa a carregar assim que você abre a seleção, então normalmente já está pronto quando
  você solta o mouse. A leitura leva cerca de 1 segundo.
- Depois de 3 minutos sem uso, o OCR é descarregado para liberar memória.
- Idiomas incluídos: português e inglês.

## Limitações

- O Chrome não permite extensões em páginas internas (`chrome://...`, Chrome Web Store).
  Nelas o ícone mostra um **!** vermelho por alguns segundos.
- Texto muito pequeno, borrado ou manuscrito pode sair com erros. Se acontecer, dê zoom na
  página (`Ctrl` + `+`) antes de selecionar.
- Em textos inclinados muito curtos (1 ou 2 letras) não dá para descobrir o ângulo com
  segurança. Se a área tiver textos em ângulos diferentes, vale o ângulo predominante;
  selecione um trecho de cada vez.

## Adicionar outro idioma

1. Baixe o arquivo `<código>.traineddata.gz` do idioma em
   `https://cdn.jsdelivr.net/npm/@tesseract.js-data/<código>/4.0.0_best_int/`
   (ex.: `spa` para espanhol, `fra` para francês) e salve em `lib/lang/`.
2. Em `offscreen/offscreen.js`, acrescente o código em `LANGUAGES`, por exemplo `'por+eng+spa'`.
3. Recarregue a extensão em `chrome://extensions`.

Cada idioma a mais deixa o reconhecimento um pouco mais lento.

## Estrutura

| Arquivo | Função |
| --- | --- |
| `manifest.json` | Configuração da extensão (Manifest V3). |
| `background.js` | Menu do botão direito, atalho, captura da tela e comunicação entre as partes. |
| `content/selector.js` | Camada de seleção da área e aviso com o resultado, injetados na página só quando usados. |
| `offscreen/` | Página invisível que recorta a captura, roda o OCR e copia o texto. |
| `lib/` | [Tesseract.js](https://github.com/naptha/tesseract.js) 7.0.0 e os dados de idioma (licença Apache 2.0). |
| `icons/` | Ícones da extensão. |

## Permissões usadas

- **activeTab**: acessar só a aba em que você acionou a extensão, e só naquele momento.
- **contextMenus**: adicionar o item no menu do botão direito.
- **scripting**: mostrar a camada de seleção na página.
- **offscreen**: rodar o OCR numa página invisível da extensão.
- **clipboardWrite**: copiar o texto reconhecido.
