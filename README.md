# ToFast: Пятница

Личный ассистент Омара. Мозг работает на ПК под Windows: это [OpenJarvis](https://github.com/open-jarvis/OpenJarvis) (Stanford, Apache 2.0) с Claude через API. Общаешься с ним через Telegram. Звонки, SMS и запуск приложений на телефоне делает маленькое Android-приложение (мост), которое принимает команды от ПК.

План и устройство описаны в [docs/architecture.md](docs/architecture.md).

## Запуск на ПК (Windows)

Нужен Python 3.11, 3.12 или 3.13.

```powershell
cd pc
py -3.12 -m venv .venv
.venv\Scripts\activate
pip install -e .
copy .env.example .env
notepad .env
```

В `.env` впиши ключ Claude API, токен Telegram-бота (создаётся у @BotFather) и свой chat id (его показывает @userinfobot). Потом:

```powershell
python -m jarvis_pc
```

Напиши боту в Telegram. Команда `/reset` очищает память разговора. Когда Пятница просит подтвердить действие (отправить письмо, выполнить команду на ПК, платный звонок через Twilio), ответь `/yes` или `/no`.

Почта, Twilio и трекер целей включаются, когда заполнены их строки в `.env`. Почта: Gmail с пересылкой с UVic, инструкция в [docs/email.md](docs/email.md). Заметки и управление ПК работают сразу.

Пока Android-моста нет, на просьбы позвонить или написать SMS Пятница ответит, что телефон не настроен. Всё остальное (вопросы, поиск в интернете, расчёты) уже работает.

## Тесты

```powershell
pip install -e ".[dev]"
pytest
```

## Лицензия OpenJarvis

OpenJarvis подключён как зависимость (`openjarvis==1.0.4`), его код в репозиторий не копируется. Атрибуция в [NOTICE](NOTICE).
