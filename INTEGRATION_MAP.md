# Конкретная интеграция с предоставленными workflow

- `JARVIS — Dialog Stable (4).json` — webhook POST `/webhook/jarvis-dialog`; тело `{mode:'start'|'ask',text,device_id:'my-iphone',session_id}`; возвращает `{ok,speak,end_session,requires_confirmation,diagnostics}`. Сессии хранятся в `$getWorkflowStaticData('global')`.
- `JARVIS — REST Stable (3).json` — вызывается из Dialog, содержит доступ к конкретному порталу Битрикс24 и ownerUserId; с PWA напрямую **не вызываем**.
- `JARVIS — MCP Astra (2).json` — вызывается из Dialog для углублённого анализа. PWA напрямую **не вызывает**.
- `OpenAI — Generate MP3 (3).json` — обычная генерация MP3, в Beta **не используется**. Вместо неё backend делает потоковый ElevenLabs TTS с тем же голосом. Старый workflow можно оставить активным для Siri.

Все четыре исходных файла остались без изменений.
