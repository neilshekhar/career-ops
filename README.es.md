<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/wordmark-dark.svg"><img src="docs/wordmark-light.svg" alt="career-ops" width="250" height="56"></picture></p>

<div align="center">

[English](README.md) | [Español](README.es.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [Português (Brasil)](README.pt-BR.md) | [한국어](README.ko-KR.md) | [日本語](README.ja.md) | [简体中文](README.cn.md) | [繁體中文](README.zh-TW.md) | [Українська](README.ua.md) | [Русский](README.ru.md) | [Polski](README.pl.md) | [Dansk](README.da.md) | [العربية](README.ar.md) | [हिन्दी](README.hi.md)

</div>

<p align="center">
  <a href="https://github.com/neilshekhar/career-ops"><img src="docs/hero-banner.jpg" alt="Career-Ops Sistema Multi-Agente de Busqueda de Empleo" width="800"></a>
</p>

<p align="center">
  <sub>🍴 Este es <a href="https://github.com/neilshekhar/career-ops"><strong>neilshekhar/career-ops</strong></a>, mantenido y ampliado por <a href="https://github.com/neilshekhar">Neil Shekhar</a> — un fork del <a href="https://github.com/santifer/career-ops">career-ops</a> original creado por <a href="https://santifer.io">santifer</a>.</sub>
</p>

<p align="center">
  <em>Aplicar a empleos a la manera tradicional se lleva meses. Este es el sistema construido para arreglarlo.</em><br>
  Las empresas usan IA para filtrar candidatos. <strong>Esto pone la IA en manos de los candidatos para <em>elegir</em> empresas.</strong><br>
  <em>Open source.</em>
</p>

<p align="center"><sub>★ Reconocimiento y prensa obtenidos por el proyecto original <a href="https://github.com/santifer/career-ops">career-ops</a></sub></p>

<p align="center">
  <a href="https://trendshift.io/repositories/25195" target="_blank"><img src="https://trendshift.io/api/badge/repositories/25195" alt="santifer%2Fcareer-ops | Trendshift" style="width: 245px; height: 54px; vertical-align: middle;" width="245" height="54"/></a>
  &nbsp;&nbsp;
  <a href="https://www.producthunt.com/products/santifer-io?utm_source=badge-featured&utm_medium=badge" target="_blank"><img src="docs/press/producthunt.svg" alt="career-ops on Claude | Product Hunt" style="width: 206px; height: 54px; vertical-align: middle;" width="206" height="54"/></a>
</p>

<p align="center"><sub>APARECE EN</sub></p>

<p align="center">
  <a href="https://wired.com.gr/article/to-ai-ergaleio-pou-fernei-epanastasi-ston-tropo-pou-psachnoume-douleia/" rel="noopener noreferrer nofollow"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/press/wired-dark.svg"><img src="docs/press/wired.svg" alt="WIRED" height="32"></picture></a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://www.businessinsider.com/how-i-built-tool-filter-job-listings-landed-head-ai-2026-4" rel="noopener noreferrer nofollow"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/press/business-insider-dark.svg"><img src="docs/press/business-insider.svg" alt="Business Insider" height="32"></picture></a>
</p>

---

<p align="center">
  <img src="docs/demo.gif" alt="career-ops Demo" width="800">
</p>

<p align="center"><strong>740+ ofertas evaluadas · 100+ CVs personalizados · 1 trabajo soñado conseguido</strong></p>

<p align="center">
  <a href="https://claude.com/claude-code"><img src="https://img.shields.io/badge/Built_with-Claude_Code-000?style=for-the-badge&logo=anthropic&logoColor=white" alt="Built with Claude Code"></a>
</p>

<p align="center">
  <sub>También funciona en cualquier CLI compatible con el estándar agent-skill</sub><br>
  <img src="https://img.shields.io/badge/Claude_Code-000?style=flat&logo=anthropic&logoColor=white" alt="Claude Code">
  <img src="https://img.shields.io/badge/OpenCode-111827?style=flat&logo=terminal&logoColor=white" alt="OpenCode">
  <img src="https://img.shields.io/badge/Gemini_CLI-4285F4?style=flat&logo=google&logoColor=white" alt="Gemini CLI">
  <img src="https://img.shields.io/badge/Codex-412991?style=flat&logo=openai&logoColor=white" alt="Codex">
  <img src="https://img.shields.io/badge/Qwen-615CED?style=flat" alt="Qwen">
  <img src="https://img.shields.io/badge/GitHub_Copilot-000?style=flat&logo=githubcopilot&logoColor=white" alt="GitHub Copilot">
  <br>
  <img src="https://img.shields.io/badge/Node.js-339933?style=flat&logo=node.js&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/Go-00ADD8?style=flat&logo=go&logoColor=white" alt="Go">
  <img src="https://img.shields.io/badge/Playwright-2EAD33?style=flat&logo=playwright&logoColor=white" alt="Playwright">
  <img src="https://img.shields.io/badge/Bubble_Tea-FF75B5?style=flat&logo=go&logoColor=white" alt="Bubble Tea">
  <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT">
  <a href="TRADEMARK.md"><img src="https://img.shields.io/badge/Trademark-Policy-blue.svg" alt="Trademark Policy"></a>
</p>

## Qué es esto

career-ops convierte cualquier CLI de IA en un centro de mando de búsqueda de empleo. En vez de trackear aplicaciones en un spreadsheet, tienes un pipeline AI que:

- **Evalua ofertas** con un sistema A-G estructurado (10 dimensiones de puntuacion mas analisis de legitimidad)
- **Genera PDFs personalizados** -- CVs ATS-optimizados por oferta
- **Escanea portales** automaticamente (Greenhouse, Ashby, Lever, webs de empresas)
- **Procesa en batch** -- evalúa 10+ ofertas en paralelo con sub-agentes
- **Trackea todo** en una fuente de verdad única con checks de integridad

> **Importante: Esto NO es para spamear empresas.** career-ops es un filtro -- te ayuda a encontrar las pocas ofertas que merecen tu tiempo entre cientos. El sistema recomienda encarecidamente no aplicar a nada por debajo de 4.0/5. Tu tiempo es valioso, y el del recruiter también. Siempre revisa antes de enviar.

> **Aviso: las primeras evaluaciones no serán buenas.** El sistema no te conoce todavía. Dale contexto -- tu CV, tu historia profesional, tus proof points, tus preferencias, en qué eres bueno, qué quieres evitar. Cuanto más lo nutras, mejor filtra. Piensa en ello como hacer onboarding a un recruiter nuevo: la primera semana necesita conocerte, luego se vuelve invaluable.

Originalmente construido por [santifer](https://santifer.io), quien lo uso para evaluar 740+ ofertas, generar 100+ CVs personalizados, y conseguir un rol de Head of Applied AI. [Lee el case study completo](https://santifer.io/career-ops-system).

## Features

| Feature                    | Descripción                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Auto-Pipeline**          | Pega una URL: primero evalua/puntua y muestra el veredicto; los materiales personalizados y la candidatura requieren continuar explicitamente o seleccionar en el dashboard |
| **Evaluacion A-G**         | Resumen del rol, match con CV, estrategia de nivel, research de comp, personalizacion, prep de entrevista (STAR+R) y verificacion de legitimidad (Bloque G) |
| **Banco de historias**     | Acumula historias STAR+Reflexion entre evaluaciones -- 5-10 historias maestras que responden cualquier pregunta behavioral     |
| **Scripts de negociacion** | Frameworks de negociacion salarial, pushback de descuentos geograficos, leverage de ofertas competidoras                       |
| **PDFs ATS**               | CVs con keywords inyectados, diseño Space Grotesk + DM Sans                                                                    |
| **Scanner de portales**    | 45+ empresas pre-configuradas (Anthropic, OpenAI, ElevenLabs, Retool, n8n...) + queries en Ashby, Greenhouse, Lever, Wellfound |
| **Batch**                  | Evaluacion en paralelo con workers `claude -p`                                                                                 |
| **Dashboard kanban local** | Dashboard para revisar y preparar roles, encolar solicitudes de candidatura para el agente activo e inspeccionar trabajo listo para revisión |
| **Human-in-the-Loop**      | La IA evalúa y recomienda, tú decides y actúas. El sistema nunca envía una candidatura: tú siempre tienes la última palabra <!-- hitl: absolute guarantee. Do not add "automatically", "by itself", "without your permission" or any other hedge when translating this row. -->   |
| **Integridad de pipeline** | Merge automatico, dedup, normalizacion de estados, health checks                                                               |

## Inicio rápido

**La forma más rápida — un solo comando:**

```bash
npx @neilshekhar/career-ops init
```

> 💡 `npx` viene incluido con [Node.js](https://nodejs.org) — ejecuta el instalador una vez, sin instalar nada de forma global. ¿No tienes Node? Instálalo primero. (¿Ya usas un CLI como Claude Code / Gemini / Codex? Entonces ya lo tienes.)

Esto clona la última release en `./career-ops` e instala las dependencias. Después:

```bash
cd career-ops
claude   # o gemini / codex / qwen / opencode — abre tu CLI de IA aquí
```

**En el primer arranque, career-ops te guía en la configuración — tu CV, tu perfil y los roles que buscas — simplemente conversando. No hay nada qué editar a mano.**

<details>
<summary><b>¿Prefieres instalarlo manualmente? (git clone)</b></summary>

```bash
git clone https://github.com/neilshekhar/career-ops.git
cd career-ops && npm install
npx playwright install chromium   # necesario para PDFs y verificación de navegador/vigencia con Playwright
claude   # abre tu CLI de IA — te guiara en el primer arranque
```

</details>

> **El sistema está diseñado para que Claude lo personalice.** Modes, arquetipos, scoring, scripts de negociación -- solo pídelo. Claude lee los mismos archivos que usa, así que sabe exactamente qué editar.

Guía completa en [docs/SETUP.md](docs/SETUP.md).

## Uso

career-ops es un único slash command con multiples modos:

```
/career-ops                → Mostrar todos los comandos
/career-ops {pega un JD}   → Evaluacion/puntuacion y veredicto primero; espera confirmacion o seleccion en el dashboard
/career-ops scan           → Escanear portales
/career-ops pdf            → Generar CV ATS-optimizado
/career-ops batch          → Evaluar ofertas en batch
/career-ops tracker        → Ver estado de aplicaciones
/career-ops apply          → Rellenar formularios con IA
/career-ops pipeline       → Procesar URLs pendientes
/career-ops contacto       → Mensaje LinkedIn outreach
/career-ops deep           → Research profundo de empresa
```

O simplemente pega una URL o descripcion de oferta -- career-ops la detecta, evalua/puntua y muestra primero el veredicto. Segun `modes/_custom.md`, no genera materiales personalizados, no avanza el estado de candidatura en el tracker, no selecciona una oferta, no abre el navegador ni rellena el formulario en vivo hasta que continues explicitamente o selecciones la oferta en el dashboard.

## Cómo funciona

```
Pegas una URL o descripción de oferta
        │
        ▼
┌──────────────────┐
│  Detección de    │  Clasifica: LLMOps / Agentic / PM / SA / FDE / Transformation
│  Arquetipo       │
└────────┬─────────┘
         │
┌────────▼─────────┐
│  Evaluacion A-G  │  Match, gaps, comp research, historias STAR, legitimidad
│  (lee cv.md)     │
└────────┬─────────┘
         │
         ▼
Puntuacion/veredicto + informe + estado del tracker: Evaluated
         │
         ▼
Continuar explicitamente o seleccionar en el dashboard
         │
         ▼
Materiales personalizados → navegador/relleno en vivo → revision y envio del candidato
```

## Portales incluidos

El scanner viene con **45+ empresas** pre-configuradas y **19 queries** en los principales portales de empleo. Copia `templates/portals.example.yml` a `portals.yml` y añade las tuyas:

**AI Labs:** Anthropic, OpenAI, Mistral, Cohere, LangChain, Pinecone
**Voice AI:** ElevenLabs, PolyAI, Parloa, Hume AI, Deepgram, Vapi, Bland AI
**Plataformas AI:** Retool, Airtable, Vercel, Temporal, Glean, Arize AI
**Contact Center:** Ada, LivePerson, Sierra, Decagon, Talkdesk, Genesys
**Enterprise:** Salesforce, Twilio, Gong, Dialpad
**LLMOps:** Langfuse, Weights & Biases, Lindy, Cognigy, Speechmatics
**Automatización:** n8n, Zapier, Make.com
**Europa:** Factorial, Attio, Tinybird, Clarity AI, Travelperk

**Portales de empleo:** Ashby, Greenhouse, Lever, Wellfound, Workable, RemoteFront

## Dashboard kanban local

El dashboard kanban local es la interfaz principal de revision en career-ops. Corre solo en tu maquina, se abre en el navegador y organiza roles en Inbox, To Do, Prepared, In Review y Done.

```bash
npm run launch   # abre http://127.0.0.1:7777
```

Usalo para revisar scores, elegir que roles preparar, poner solicitudes duraderas de candidatura en cola para el agente activo, inspeccionar borradores/archivos y mantener revision humana antes de enviar. El dashboard nunca lanza automatizacion del navegador ni rellena o envia candidaturas por si mismo.

### Terminal Tracker TUI

El dashboard de terminal sigue disponible como vista secundaria para tracker/reportes:

```bash
npm run serve:dashboard
npm run build:dashboard
```

Funciones: 6 pestañas de filtro, 4 modos de ordenación, vista agrupada/plana,
previews lazy-loaded y cambios de estado inline.

## Estructura del proyecto

```
career-ops/
├── AGENTS.md                    # Instrucciones canónicas del agente (todos los CLIs)
├── CLAUDE.md                    # Wrapper Claude Code (importa AGENTS.md)
├── cv.md                        # Tu CV (crealo tu)
├── article-digest.md            # Tus proof points (opcional)
├── config/
│   └── profile.example.yml      # Template para tu perfil
├── modes/                       # 14 modos
│   ├── _shared.md               # Contexto compartido (capa de sistema — personaliza _profile.md/_custom.md en su lugar)
│   ├── oferta.md                # Evaluacion individual
│   ├── pdf.md                   # Generacion de PDF
│   ├── scan.md                  # Scanner de portales
│   ├── batch.md                 # Procesamiento batch
│   └── ...
├── templates/
│   ├── cv-template.html         # Template de CV ATS-optimizado
│   ├── portals.example.yml      # Config del scanner
│   └── states.yml               # Estados canónicos
├── batch/
│   ├── batch-prompt.md          # Prompt autocontenido del worker
│   └── batch-runner.sh          # Script orquestador
├── dashboard/                   # Dashboard kanban local + tracker Go TUI
├── data/                        # Tus datos de tracking (gitignored)
├── reports/                     # Reports de evaluación (gitignored)
├── output/                      # PDFs generados (gitignored)
├── fonts/                       # Space Grotesk + DM Sans
├── docs/                        # Setup, personalización, arquitectura
└── examples/                    # CV de ejemplo, report, proof points
```

## Tech Stack

![Claude Code](https://img.shields.io/badge/Claude_Code-000?style=flat&logo=anthropic&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat&logo=node.js&logoColor=white)
![Playwright](https://img.shields.io/badge/Playwright-2EAD33?style=flat&logo=playwright&logoColor=white)
![Go](https://img.shields.io/badge/Go-00ADD8?style=flat&logo=go&logoColor=white)
![Bubble Tea](https://img.shields.io/badge/Bubble_Tea-FF75B5?style=flat&logo=go&logoColor=white)

- **Agente**: Claude Code con skills y modos personalizados
- **PDF**: Playwright + template HTML
- **Scanner**: Playwright + Greenhouse API + WebSearch
- **Dashboard**: Go + Bubble Tea + Lipgloss (tema Catppuccin Mocha)
- **Datos**: Tablas Markdown + config YAML + ficheros TSV batch

## Preguntas frecuentes (FAQ)

**¿Qué es career-ops?**
career-ops es un centro de mando de búsqueda de empleo, open source e independiente del CLI. Convierte cualquier CLI de IA en un pipeline que evalúa ofertas contra tu CV, genera PDFs optimizados para ATS, encuentra a la persona adecuada a la que escribir y lo registra todo en un solo sitio — y la decisión final siempre es tuya. Es la primera implementación de referencia del CareerOps Manifesto. Más en [career-ops.org](https://career-ops.org).

**¿Puedo usar career-ops gratis, o con un modelo más barato o local?**
Sí. career-ops es independiente del CLI y funciona con modelos gratuitos y locales — mediante modelos gratuitos de OpenRouter, Ollama o cualquier endpoint compatible con OpenAI — así no dependes de ninguna suscripción de pago. Consulta [docs/RUNNING_ON_A_BUDGET.md](docs/RUNNING_ON_A_BUDGET.md) para la configuración completa.

**¿Con qué CLIs de IA funciona career-ops?**
career-ops funciona con cualquier CLI de IA importante — Claude Code, Codex, Gemini / Antigravity, OpenCode, Grok, Qwen y más — a través del estándar abierto Agent Skill Standard, así que nunca queda atado a un solo proveedor. Usa el CLI que ya tengas.

**¿Cómo instalo career-ops en Windows?**
career-ops funciona en Windows. Si las skills no cargan por un error de symlink durante la instalación, la solución está en [docs/FAQ.md](docs/FAQ.md). Los pasos completos están en [docs/SETUP.md](docs/SETUP.md).

**¿career-ops aplica a las ofertas por mí automáticamente?**
No. career-ops es un filtro, no un aplicador masivo a ciegas. Para los roles
que seleccionas explícitamente puede preparar materiales y rellenar el formulario
para tu revisión, pero nunca pulsa el control final de envío. La última palabra
siempre es tuya.

**¿career-ops es gratis y open source?**
Sí. career-ops es gratis y open source, y para el candidato siempre lo será — es la primera implementación de referencia del [CareerOps Manifesto](https://career-ops.org/manifesto).

## Creditos y Origen

career-ops fue **creado originalmente por [Santiago Fernandez de Valderrama (santifer)](https://santifer.io)** -- Head of Applied AI y ex-fundador. Lo construyo para gestionar su propia busqueda de empleo, y lo uso para conseguir su puesto actual. Su portfolio y otros proyectos open source → [santifer.io](https://santifer.io).

¿Curiosidad por cómo se mantiene este repo en ~4 horas a la semana? Lee [Agentic maintenance: how career-ops is run by a fleet of AI agents](https://santifer.io/ai-agent-fleet).

**Este repositorio, [neilshekhar/career-ops](https://github.com/neilshekhar/career-ops), es un fork mantenido y ampliado por [Neil Shekhar](https://github.com/neilshekhar)** -- con arreglos y funcionalidades adicionales sobre el trabajo original de santifer, y sincronizado periodicamente con el upstream.

Wikidata: [Santiago Fernández de Valderrama Aparicio](https://www.wikidata.org/wiki/Q138710224) · [career-ops](https://www.wikidata.org/wiki/Q139007988).

## Documentación

- [SETUP.md](docs/SETUP.md) -- Guía de instalación
- [CUSTOMIZATION.md](docs/CUSTOMIZATION.md) -- Como personalizar
- [ARCHITECTURE.md](docs/ARCHITECTURE.md) -- Cómo funciona el sistema

## También Open Source

- **[cv-santiago](https://github.com/santifer/cv-santiago)** -- El portfolio (santifer.io) con chatbot IA, dashboard LLMOps y case studies. Si necesitas un portfolio para acompañar tu búsqueda de empleo, échale un vistazo.


## Aviso legal

**career-ops es una herramienta local y open source — NO un servicio alojado.** Al usar este software, aceptas que:

1. **Tu controlas tus datos.** Tu CV, datos de contacto e información personal se quedan en tu máquina y se envian directamente al proveedor de IA que elijas (Anthropic, OpenAI, etc.). No recopilamos, almacenamos ni tenemos acceso a tus datos.
2. **Tu controlas la IA.** Los prompts por defecto instruyen a la IA a no enviar aplicaciones automaticamente, pero los modelos pueden comportarse de forma impredecible. Si modificas los prompts o usas otros modelos, lo haces bajo tu responsabilidad. **Revisa siempre el contenido generado antes de enviarlo.**
3. **Tu cumples con los terminos de terceros.** Debes usar esta herramienta de acuerdo con los Terminos de Servicio de los portales de empleo (Greenhouse, Lever, Workday, LinkedIn, etc.). No uses esta herramienta para spamear empresas.
4. **Sin garantias.** Las evaluaciones son recomendaciones, no verdad absoluta. Los modelos pueden inventar habilidades o experiencia. Los autores no son responsables de resultados laborales, candidaturas rechazadas, restricciones de cuenta ni ninguna otra consecuencia.

Ver [LEGAL_DISCLAIMER.md](LEGAL_DISCLAIMER.md) para más detalles. Este software se proporciona bajo la [Licencia MIT](LICENSE) "tal cual", sin garantia de ningun tipo.

## Colaboradores

<p align="center">
  <a href="https://github.com/neilshekhar">
    <img src="https://github.com/neilshekhar.png?size=96" width="96" height="96" alt="Neil Shekhar" />
  </a>
  <br>
  <sub><b><a href="https://github.com/neilshekhar">Neil Shekhar</a></b></sub>
</p>

## Licencia

MIT

## Conecta

**Este fork** — [![GitHub](https://img.shields.io/badge/GitHub-neilshekhar-181717?style=for-the-badge&logo=github&logoColor=white)](https://github.com/neilshekhar/career-ops)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-neil--shekhar-0A66C2?style=for-the-badge&logo=linkedin&logoColor=white)](https://www.linkedin.com/in/neil-shekhar/)

**Autor original (santifer)** — [![Website](https://img.shields.io/badge/santifer.io-000?style=for-the-badge&logo=safari&logoColor=white)](https://santifer.io)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-0A66C2?style=for-the-badge&logo=linkedin&logoColor=white)](https://linkedin.com/in/santifer)
[![X](https://img.shields.io/badge/X-000?style=for-the-badge&logo=x&logoColor=white)](https://x.com/santifer)
