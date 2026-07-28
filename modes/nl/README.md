# career-ops -- Nederlandstalige modi (`modes/nl/`)

Deze map bevat een Nederlandse markt- en taaloverlay voor kandidaten die zich richten op Nederland en Vlaanderen. De uitvoerbare workflows blijven de canonieke rootmodi; de lokale bestanden zijn wrappers, zodat veiligheids- en proceswijzigingen niet tussen vertalingen uiteenlopen.

## Wanneer gebruik je deze modi?

Gebruik `modes/nl/` als aan minstens één van deze voorwaarden is voldaan:

- Je solliciteert voornamelijk op **Nederlandstalige vacatures** (LinkedIn, Indeed NL/BE, Nationale Vacaturebank, VDAB, Werkenvoor.be, bedrijfssites)
- Je **cv is in het Nederlands** of je wisselt tussen NL en EN, afhankelijk van de vacature
- Je hebt antwoorden en motivatiebrieven nodig in **natuurlijk technisch Nederlands**, zonder letterlijke vertalingen
- Je wilt rekening houden met **arbeidsvoorwaarden in Nederland en België**: cao/sectorale afspraken, vakantiegeld, pensioen, bonus of dertiende maand, proefperiode, opzegtermijn en aanvullende verzekeringen

Als de meeste vacatures in het Engels zijn, gebruik dan de standaardmodi in `modes/`. De Engelse modi werken ook voor Nederlandstalige vacatures, maar behandelen de Nederlandse en Belgische arbeidsmarkt minder specifiek.

## Hoe activeren?

### Optie 1 -- Per sessie

Vertel de AI-agent aan het begin van de sessie:

> "Gebruik Nederlandse modi onder `modes/nl/`."

De agent leest deze overlay naast de canonieke bestanden in `modes/`.

### Optie 2 -- Permanent

Voeg in `config/profile.yml` toe:

```yaml
language:
  output: nl
  modes_dir: modes/nl
```

De agent gebruikt dan de Nederlandse marktcontext en schrijft de kandidaatgerichte uitvoer in het Nederlands.

## Welke lokale wrappers zijn aanwezig?

Deze eerste iteratie omvat de vier modi met de hoogste impact:

| Bestand | Canoniek contract | Rol |
|--------|----------------|------|
| `_shared.md` | `modes/_shared.md` | Nederlandstalige marktcontext en woordgebruik |
| `vacature.md` | `modes/oferta.md` | Wrapper voor de volledige A-G-evaluatie |
| `solliciteren.md` | `modes/apply.md` | Wrapper voor de live sollicitatie- en reviewflow |
| `pipeline.md` | `modes/pipeline.md` | Wrapper voor de URL-inbox |

De andere modi (`scan`, `batch`, `pdf`, `tracker`, `auto-pipeline`, `deep`, `contacto`, `ofertas`, `project`, `training`) blijven in EN/ES. Hun inhoud bestaat voornamelijk uit tools, paden en commando's - het moet taalonafhankelijk blijven.

## Wat blijft in het Engels

Opzettelijk niet vertaald vanwege standaard technische woordenschat:

- `cv.md`, `pipeline`, `tracker`, `report`, `score`, `archetype`
- Toolnamen (`Playwright`, `WebSearch`, `WebFetch`, `Read`, `Write`, `Edit`, `Bash`)
- Statuswaarden in de tracker (`Evaluated`, `Applied`, `Interview`, `Offer`, `Rejected`)
- Codefragmenten, paden, opdrachten

De modi gebruiken natuurlijk technisch Nederlands zoals dat in teams in Nederland en Vlaanderen wordt gesproken: gewone tekst in het Nederlands, met Engelse technische termen waar die gangbaar zijn. Termen als "pipeline", "deployment" en "stack" worden niet geforceerd vertaald.

## Referentiewoordenlijst

Om een ​​consistente toon te behouden als u de modi wijzigt of uitbreidt:

| Engels | Nederlands (in deze codebase) |
|---------|----------------------------|
| Job posting | Vacature |
| Application | Sollicitatie |
| Cover letter | Sollicitatiebrief |
| Resume / CV | Cv |
| Salary | Salaris |
| Compensation | Beloning / arbeidsvoorwaardenpakket |
| Skills | Vaardigheden |
| Interview | Sollicitatiegesprek |
| Hiring manager | Wervende manager / hiring manager |
| Recruiter | Recruiter |
| AI | AI (kunstmatige intelligentie) |
| Requirements | Vereisten |
| Career history | Loopbaan / werkervaring |
| Notice period | Opzegtermijn |
| Probation | Proeftijd |
| Vacation | Vakantiedagen / betaald verlof |
| 13th month salary | Dertiende maand / eindejaarsuitkering |
| Permanent employment | Arbeidsovereenkomst voor onbepaalde tijd / vast contract |
| Fixed-term contract | Arbeidsovereenkomst voor bepaalde tijd / tijdelijk contract |
| Freelance | Freelance / zelfstandig |
| Collective agreement | Cao (NL) / sectorale cao of paritair comité (BE) |
| Works council | Ondernemingsraad |
| Profit sharing | Winstdeling / winstpremie |
| Meal vouchers | Maaltijdcheques (vooral BE) |
| Health insurance | Zorgverzekering (NL) / hospitalisatieverzekering (BE) |
| Disability/life insurance | Arbeidsongeschiktheids- en overlijdensverzekering |
| Holiday allowance | Vakantiegeld |
| Pension | Pensioenregeling / groepsverzekering |

## Bijdragen

Om een ​​vertaling te verbeteren of een modus toe te voegen:

1. Open een probleem met uw voorstel (zie `CONTRIBUTING.md`)
2. Respecteer de bovenstaande woordenlijst om de toon consistent te houden
3. Vertaal idiomatisch - geen woord-voor-woordvertaling
4. Houd structurele elementen (blokken A-F, tabellen, codeblokken, gereedschapsinstructies) identiek
5. Test met een echte Nederlandstalige vacature (LinkedIn, Indeed NL, Nationale Vacaturebank) voordat je de PR indient
