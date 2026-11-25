# Универсальная архитектура JARVIS (план, не реализовано)

Демо: PWA → собственный backend (`/api/transcribe`, `/api/turn`, `/api/speech`) → n8n Dialog Stable → REST/MCP Bitrix24; генерация ответа GPT в существующих workflow, ElevenLabs только TTS.

Чтобы продавать JARVIS другим клиентам:

1. В backend настроить **реальную авторизацию каждого пользователя** (не общий PIN). Профиль хранит `tenant_id`, `bitrix_user_id`, индивидуальные разрешения.
2. Создать защищённое хранилище tenants (например, Postgres): tenant_id, portal_domain, credential_id, provider, voice_id, allowed_scope. Секреты хранить в Secret Manager, никогда в PWA и не внутри экспортируемого JSON.
3. Использовать Bitrix24 OAuth для установки на разные порталы либо изолированные токены/вебхуки с минимальными разрешениями. Отдельная проверка прав пользователя на каждое действие.
4. Убрать фиксированные `my-iphone` / `ownerUserId=1` / REST URL из кода. n8n получает валидированный контекст tenant и user из backend, не из пользовательского JSON.
5. Изолировать session context, memory, подтверждения изменений, job/queue, историю, логи, квоты и ограничения по ключу tenant+user+session.
6. Разделить `IntelligenceProvider` с адаптерами OpenAI/Anthropic. Схема унифицированного результата: `action`, `command`, `speak`, `requires_confirmation`, `end_session`, `tool_calls`. Переписать OpenAI-specific `response_format` / JSON-mode / tool definitions для Claude и провести регрессионные тесты CRM команд.
7. Сохранить проверку подтверждений операций **на сервере**, не доверять просто голосовому ответу «да» без привязки к текущему pending action.

Не переключайте `JARVIS_PROVIDER=anthropic` в текущем демо, думая, что этого достаточно. Сейчас эта переменная — лишь метаданные, переключение Claude не реализовано.
