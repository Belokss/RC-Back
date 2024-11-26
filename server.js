const express = require('express');
const mysql = require('mysql2/promise');
const axios = require('axios');
const multer = require('multer');
const fs = require('fs');
const FormData = require('form-data');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors()); // Перенесено после инициализации app

// Настройка соединения с базой данных
const db = mysql.createPool({
    host: process.env.MYSQLHOST,            // Используем переменные окружения от Railway
    user: process.env.MYSQLUSER,
    password: process.env.MYSQL_ROOT_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    port: process.env.MYSQLPORT,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Настройка хранилища для multer
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/');
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({ storage: storage });

// Создание папки uploads, если ее нет
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}

// Функция для корректировки распространенных ошибок распознавания (опционально)
const correctTranscriptions = (text) => {
    const corrections = {
        'tajota': 'Toyota',
        'bremzha diski': 'bremžu disks',
        // Добавьте другие частые ошибки здесь
    };
    let correctedText = text.toLowerCase();
    for (const [incorrect, correct] of Object.entries(corrections)) {
        const regex = new RegExp(`\\b${incorrect}\\b`, 'g');
        correctedText = correctedText.replace(regex, correct);
    }
    return correctedText;
};

// Обработка текстовой команды
app.post('/api/process-command', async (req, res) => {
    const { command, language } = req.body;

    console.log(`Processing text command [Language: ${language}]:`, command);

    let prompt = '';

    if (language === 'ru') {
        prompt = `
Преобразуйте следующую команду на русском языке в структурированный JSON в указанном формате. Используйте **только** информацию из команды. Не добавляйте никаких дополнительных данных или вымышленных элементов.

Команда: "${command}"

Требования:

1. Разбейте команду на отдельные действия, если их несколько.
2. Для каждой команды верните объект в следующем формате:

{
  "manufacturer": "<ražotājs angļu valodā>",
  "part": "<detālām latviešu valodā>",
  "model": "<modelis vai virsbūve latviešu valodā>",
  "quantity": <daudzums>,
  "action": "<add vai remove>"
}

3. Используйте латышский язык для всех полей и значений, за исключением "manufacturer", который должен быть на английском.
4. **Не придумывайте данные**, отсутствующие в команде.
5. Если действие не указано явно, установите "action" как "add".
6. Учтите, что некоторые термины могут быть автомобильными и популярными брендами.
7. Ответ должен быть строго в формате JSON, без дополнительного текста или комментариев.

Пример ответа:

{
  "changes": [
    {
      "manufacturer": "Toyota",
      "part": "bremžu disks",
      "model": "Corolla",
      "quantity": 1,
      "action": "add"
    }
  ]
}
`;
    } else if (language === 'lv') {
        prompt = `
Pārveido sekojošo komandu latviešu valodā strukturētā JSON norādītajā formātā. Izmanto **tikai** informāciju no komandas. Nepievieno nekādu papildus informāciju vai izdomātus elementus.

Komanda: "${command}"

Prasības:

1. Sadaliet komandu atsevišķās darbībās, ja tādas ir vairākas.
2. Katrai komandai atgrieziet objektu sekojošā formātā:

{
  "manufacturer": "<ražotājs angļu valodā>",
  "part": "<detālām latviešu valodā>",
  "model": "<modelis vai virsbūve latviešu valodā>",
  "quantity": <daudzums>,
  "action": "<add vai remove>"
}

3. Izmantojiet latviešu valodu visiem laukiem un vērtībām, izņemot "manufacturer", kas ir angļu valodā.
4. **Neizdomājiet datus**, kas nav norādīti komandā.
5. Ja darbība nav skaidri norādīta komandā, pieņemiet darbību "add".
6. Ņemiet vērā, ka daži termini var būt saistīti ar automobiļiem un populārām automašīnu markām.
7. Centieties saprast automobiļu terminus, iespējams, ka tiek pieminētas populāras automašīnu markas un detaļas.
8. Atbildei jābūt stingri JSON formātā, bez papildu teksta vai komentāriem.

Piemērs atbildei:

{
  "changes": [
    {
      "manufacturer": "Toyota",
      "part": "bremžu disks",
      "model": "Corolla",
      "quantity": 1,
      "action": "add"
    }
  ]
}
`;
    } else {
        res.status(400).json({ error: "Invalid language parameter" });
        return;
    }

    try {
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: "gpt-3.5-turbo",
                messages: [{ role: "user", content: prompt }],
                max_tokens: 500,
                temperature: 0,
                n: 1
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
                }
            }
        );

        const rawResponse = response.data.choices[0].message.content;
        console.log(`OpenAI API Response (text command) [Language: ${language}]:`, rawResponse);

        let structuredResponse;
        try {
            structuredResponse = JSON.parse(rawResponse.trim());
        } catch (parseError) {
            console.error("Ошибка парсинга JSON:", parseError);
            res.status(500).json({ error: "Ошибка парсинга ответа OpenAI" });
            return;
        }

        if (structuredResponse && structuredResponse.changes) {
            res.json({ changes: structuredResponse.changes });
        } else {
            console.error("Поле 'changes' не найдено в ответе OpenAI");
            res.status(500).json({ error: "Поле 'changes' не найдено в ответе OpenAI" });
        }
    } catch (error) {
        console.error("Ошибка при обращении к OpenAI:", error.message);
        res.status(500).json({ error: "Ошибка обработки команды" });
    }
});

// Обработка голосовой команды
app.post('/api/voice-command', upload.single('audio'), async (req, res) => {
    const originalFilePath = req.file.path;
    const { language } = req.body;

    console.log(`Processing voice command [Language: ${language}]`);

    try {
        const formData = new FormData();
        formData.append('file', fs.createReadStream(originalFilePath));
        formData.append('model', 'whisper-1');
        formData.append('response_format', 'json');
        formData.append('language', language === 'ru' ? 'ru' : 'lv'); // Установка языка для Whisper

        const whisperResponse = await axios.post(
            'https://api.openai.com/v1/audio/transcriptions',
            formData,
            {
                headers: {
                    ...formData.getHeaders(),
                    'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
                },
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            }
        );

        console.log("Полный ответ Whisper API:", whisperResponse.data);

        let commandText = whisperResponse.data.text?.trim();
        if (!commandText) {
            console.error("Whisper API не вернул ожидаемый текст.");
            res.status(500).json({ error: "Ошибка при распознавании речи: отсутствует текст" });
            return;
        }

        console.log(`Распознанный текст: "${commandText}"`);

        // Опциональная постобработка для исправления распространенных ошибок
        if (language === 'lv') {
            commandText = correctTranscriptions(commandText);
            console.log(`Исправленный текст: "${commandText}"`);
        }

        let prompt = '';

        if (language === 'ru') {
            prompt = `
Преобразуйте следующую команду в структурированный JSON в указанном формате. Используйте **только** информацию из команды. Не добавляйте никаких дополнительных данных или вымышленных элементов.

Команда: "${commandText}"

Требования:

1. Разбейте команду на отдельные действия, если их несколько.
2. Для каждой команды верните объект в следующем формате:

{
  "manufacturer": "<ražotājs angļu valodā>",
  "part": "<detālām latviešu valodā>",
  "model": "<modelis vai virsbūve latviešu valodā>",
  "quantity": <daudzums>,
  "action": "<add vai remove>"
}

3. Переведи на латышский язык для всех полей и значений, за исключением "manufacturer", который должен быть на английском.
4. **Не придумывайте данные**, отсутствующие в команде.
5. Если действие не указано явно, установите "action" как "add".
6. Учтите, что некоторые термины могут быть автомобильными и популярными брендами.
7. Ответ должен быть строго в формате JSON, без дополнительного текста или комментариев.

Пример ответа:

{
  "changes": [
    {
      "manufacturer": "Toyota",
      "part": "bremžu disks",
      "model": "Corolla",
      "quantity": 1,
      "action": "add"
    }
  ]
}
`;
        } else if (language === 'lv') {
            prompt = `
Pārveido sekojošo komandu latviešu valodā strukturētā JSON norādītajā formātā. Izmanto **tikai** informāciju no komandas. Nepievieno nekādu papildus informāciju vai izdomātus elementus.

Komanda: "${commandText}"

Prasības:

1. Sadaliet komandu atsevišķās darbībās, ja tādas ir vairākas.
2. Katrai komandai atgrieziet objektu sekojošā formātā:

{
  "manufacturer": "<ražotājs angļu valodā>",
  "part": "<detālām latviešu valodā>",
  "model": "<modelis vai virsbūve latviešu valodā>",
  "quantity": <daudzums>,
  "action": "<add vai remove>"
}

3. Izmantojiet latviešu valodu visiem laukiem un vērtībām, izņemot "manufacturer", kas ir angļu valodā.
4. **Neizdomājiet datus**, kas nav norādīti komandā.
5. Ja darbība nav skaidri norādīta komandā, pieņemiet darbību "add".
6. Centieties saprast automobiļu terminus, iespējams, ka tiek pieminētas populāras automašīnu markas un detaļas.
7. Atbildeи jābūt stingri JSON формātā, без папилду текста или коментариеem.

Пример ответа:

{
  "changes": [
    {
      "manufacturer": "Toyota",
      "part": "bremžu disks",
      "model": "Corolla",
      "quantity": 1,
      "action": "add"
    }
  ]
}
`;
        } else {
            res.status(400).json({ error: "Invalid language parameter" });
            return;
        }

        console.log(`Сгенерированный промпт для OpenAI (голосовая команда) [Language: ${language}]:`, prompt);

        const openAIResponse = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: "gpt-3.5-turbo",
                messages: [{ role: "user", content: prompt }],
                max_tokens: 500,
                temperature: 0,
                n: 1
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
                }
            }
        );

        const rawResponse = openAIResponse.data.choices[0].message.content;
        console.log(`OpenAI API Response (голосовая команда) [Language: ${language}]:`, rawResponse);

        let structuredResponse;
        try {
            structuredResponse = JSON.parse(rawResponse.trim());
        } catch (parseError) {
            console.error("Ошибка парсинга JSON:", parseError);
            res.status(500).json({ error: "Ошибка парсинга ответа OpenAI" });
            return;
        }

        if (structuredResponse && structuredResponse.changes) {
            res.json({ changes: structuredResponse.changes, commandText });
        } else {
            console.error("Поле 'changes' не найдено в ответе OpenAI");
            res.status(500).json({ error: "Поле 'changes' не найдено в ответе OpenAI" });
        }

    } catch (error) {
        console.error("Ошибка при обработке команды:", error.message);
        res.status(500).json({ error: "Ошибка обработки команды" });
    } finally {
        if (fs.existsSync(originalFilePath)) fs.unlinkSync(originalFilePath);
    }
});

// Выполнение изменений
app.post('/api/execute-changes', async (req, res) => {
    const { changes } = req.body;

    try {
        for (const change of changes) {
            const { manufacturer, part, model, quantity, action } = change;
            const qtyChange = action === 'add' ? (quantity || 1) : -(quantity || 1);

            const [existingParts] = await db.execute(
                'SELECT id, quantity FROM parts WHERE manufacturer = ? AND part = ? AND model = ?',
                [manufacturer, part, model]
            );

            if (existingParts.length > 0) {
                const partId = existingParts[0].id;
                const newQuantity = existingParts[0].quantity + qtyChange;

                if (newQuantity >= 0) {
                    await db.execute(
                        'UPDATE parts SET quantity = ? WHERE id = ?',
                        [newQuantity, partId]
                    );
                } else {
                    console.error(`Недостаточно количества для удаления: ${manufacturer} ${part} ${model}`);
                }
            } else if (action === 'add') {
                await db.execute(
                    'INSERT INTO parts (manufacturer, part, model, quantity) VALUES (?, ?, ?, ?)',
                    [manufacturer, part, model, quantity || 1]
                );
            } else {
                console.error(`Деталь не найдена в базе данных и невозможно удалить: ${manufacturer} ${part} ${model}`);
            }
        }

        res.json({ success: true });
    } catch (error) {
        console.error("Ошибка при выполнении изменений:", error.message);
        res.status(500).json({ error: "Ошибка при выполнении изменений" });
    }
});

// Получение всех деталей
app.get('/api/parts', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM parts');
        res.json(rows);
    } catch (error) {
        console.error("Ошибка при получении деталей:", error.message);
        res.status(500).json({ error: "Ошибка при получении деталей" });
    }
});

// Обновление детали
app.put('/api/parts/:id', async (req, res) => {
    const { id } = req.params;
    const { manufacturer, part, model, quantity } = req.body;

    try {
        await db.execute(
            'UPDATE parts SET manufacturer = ?, part = ?, model = ?, quantity = ? WHERE id = ?',
            [manufacturer, part, model, quantity, id]
        );
        res.json({ success: true });
    } catch (error) {
        console.error("Ошибка при обновлении детали:", error.message);
        res.status(500).json({ error: "Ошибка при обновлении детали" });
    }
});

// Удаление деталей
app.delete('/api/parts', async (req, res) => {
    const { ids } = req.body;

    try {
        const placeholders = ids.map(() => '?').join(',');
        await db.execute(`DELETE FROM parts WHERE id IN (${placeholders})`, ids);
        res.json({ success: true });
    } catch (error) {
        console.error("Ошибка при удалении деталей:", error.message);
        res.status(500).json({ error: "Ошибка при удалении деталей" });
    }
});

// Запуск сервера
const PORT = process.env.PORT || 5000;

(async () => {
    try {
        // Проверка подключения к базе данных
        const [rows] = await db.query('SELECT 1');
        console.log('Успешное подключение к базе данных');
    } catch (error) {
        console.error('Ошибка подключения к базе данных:', error.message);
    }

    app.listen(PORT, () => {
        console.log(`Сервер запущен на порту ${PORT}`);
    });
})();
