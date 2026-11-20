# Почта UVic в Пятнице

Почта UVic работает на Microsoft 365. Пароль приложения туда не подходит, поэтому Пятница входит через Microsoft: ты один раз подтверждаешь вход в браузере, дальше она обновляет доступ сама. Для этого нужен "Client ID", это бесплатная регистрация приложения в Microsoft.

## 1. Регистрация приложения (один раз, минут 5)

1. Зайди на https://entra.microsoft.com с личным аккаунтом Microsoft (outlook.com, hotmail и т.п.). Если его нет, создай бесплатно. Университетский аккаунт тут скорее всего не пустят регистрировать приложения.
2. App registrations, New registration.
3. Name: `Friday`. Supported account types: "Accounts in any organizational directory and personal Microsoft accounts". Redirect URI оставь пустым. Register.
4. Скопируй "Application (client) ID" и впиши в `pc/.env` как `MS_CLIENT_ID`.
5. Authentication, внизу "Allow public client flows": Yes. Save.
6. API permissions, Add a permission, Microsoft Graph, Delegated: `Mail.Read` и `Mail.Send`. Add.

## 2. Вход

В `pc/.env`:

```
EMAIL_PROVIDER=microsoft
MS_CLIENT_ID=<твой client id>
MS_TENANT=organizations
```

Потом в папке `pc`:

```powershell
python -m jarvis_pc login-email
```

Появится код. Открой https://microsoft.com/devicelogin, введи код и войди своим UVic-аккаунтом (с Duo/MFA, как обычно). Токен сохранится в `%USERPROFILE%\.openjarvis\friday_ms_token.json`, это фактически ключ от почты, никому его не отправляй.

## Если UVic попросит разрешение администратора

Некоторые университеты запрещают студентам самим разрешать доступ сторонним приложениям. Тогда после входа будет "Need admin approval". Варианты: запросить одобрение у UVic IT прямо с того экрана, или настроить пересылку почты UVic на Gmail и подключить Gmail по IMAP с паролем приложения (см. `.env.example`). Во втором случае Пятница сможет читать письма, но отправлять будет с Gmail.
