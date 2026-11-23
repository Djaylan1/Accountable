# Accountable

Wekker uit -> melding per taak -> na 60 min nog één herinnering als je niet op "gedaan" tikte.

## Starten (lokaal)
    npm install
    npm start        # print de sleutel in de log

## iPhone instellen (na het online zetten, URL = https://JOUW-URL)
1. Safari -> `https://JOUW-URL/?key=SLEUTEL` -> Delen -> **Zet op beginscherm**.
2. Open de app vanaf het beginscherm -> **Meldingen aanzetten** -> toestaan.
3. Voeg je taken toe (bv. Push-ups).
4. Opdrachten-app -> **Automatisering** -> **+** -> **Persoonlijke automatisering** -> **Wekker** -> *Wordt gestopt* (kies je wekker(s), of alle).
   - Actie: **Inhoud van URL ophalen** -> `https://JOUW-URL/wakker?key=SLEUTEL`
   - Zet **Vraag voor uitvoeren** uit.
   - Alternatief: trigger **Slaap** -> *Gaat uit*.

Een tweede wekker-stop binnen 4 uur (snooze) wordt genegeerd.
