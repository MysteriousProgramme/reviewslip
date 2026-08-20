'use strict';

/**
 * Every word the guest page says, in every language it offers.
 *
 * The selector used to change one thing: the language the review was written
 * in. That was half a feature. A guest who cannot read English cannot read
 * "Browse for more topics" either, and a page that hands them a Thai review
 * surrounded by English chrome is telling them the review is a translation
 * rather than their own words.
 *
 * One table, on the server, for two reasons. The page's own text and the
 * errors the server sends back are read by the same person in the same moment,
 * so splitting them would translate half of what they see. And the language
 * list in config.js decides what the prompt accepts — keeping the strings
 * beside it means a language cannot be offered without the words to offer it
 * in, which the tests enforce.
 *
 * Placeholders are {braced}. There is no plural machinery beyond one/many:
 * every language here either has that distinction or has none, and a CLDR
 * plural engine for "3 more tries" would be the tail wagging the dog. The
 * languages with no plural — Thai, Chinese, Japanese, Korean — write both
 * forms the same, which is correct rather than a shortcut.
 *
 * Business words are not here. Topic labels are the business's own ("The Bar",
 * "ห้องพัก") and platform names are proper nouns; translating either would be
 * inventing words nobody wrote.
 */

const STRINGS = {
  en: {
    title: 'Leave a review',
    heading: 'Thanks for stopping by',
    lede: "Here's a review in your words. Change anything you like, then post it.",
    picker: 'What stood out?',
    browseMore: 'Browse for more topics ({n})',
    browseFewer: 'Show fewer topics',
    lengthLabel: 'How long?',
    lengthAny: 'Any',
    lengthShort: 'Short',
    lengthDetailed: 'Detailed',
    reviewLabel: 'Your review',
    placeholder: 'Your review will appear here.',
    regenerate: 'Regenerate',
    regenerateCount: 'Regenerate ({used}/{max})',
    copy: 'Copy',
    copied: 'Copied',
    language: 'Language',
    proceed: 'Proceed to {place}',
    hint: 'Copies your review, then opens the listing.',
    noLink: 'No review link set yet.',
    pasteCopied: 'Copied. Tap "Write a review" on {place}, then paste.',
    pasteManual:
      'Select the review and copy it, then tap "Write a review" on {place}.',
    nothingToCopy: 'Nothing to copy yet.',
    languageChanged: 'The next one will be written in that language.',
    lastTry: 'That is the last one for now. Edit it however you like.',
    triesOne: '{n} more try for now.',
    triesMany: '{n} more tries for now.',
    loadFailed: 'Could not load the page settings.',
    writerFailed: 'Could not reach the writer. Try again.',
    noKey: 'No OpenRouter key yet. Add one in Settings.',
    tooFast: 'That is a lot of reviews. Wait a moment and try again.',
    outOfTries:
      'You have used the reviews available for now. Edit the one you have — it is yours to change.',
    writerDown: "The writer is unavailable right now. Try again.",
    writerEmpty: "The writer came back empty. Try again.",
  },

  th: {
    title: 'เขียนรีวิว',
    heading: 'ขอบคุณที่มาใช้บริการ',
    lede: 'นี่คือรีวิวในคำพูดของคุณ แก้ไขได้ตามต้องการ แล้วโพสต์เลย',
    picker: 'อะไรที่ประทับใจคุณ?',
    browseMore: 'ดูหัวข้ออื่นเพิ่มเติม ({n})',
    browseFewer: 'แสดงหัวข้อน้อยลง',
    lengthLabel: 'ความยาวเท่าไร?',
    lengthAny: 'แบบไหนก็ได้',
    lengthShort: 'สั้น',
    lengthDetailed: 'ละเอียด',
    reviewLabel: 'รีวิวของคุณ',
    placeholder: 'รีวิวของคุณจะปรากฏที่นี่',
    regenerate: 'สร้างใหม่',
    regenerateCount: 'สร้างใหม่ ({used}/{max})',
    copy: 'คัดลอก',
    copied: 'คัดลอกแล้ว',
    language: 'ภาษา',
    proceed: 'ไปที่ {place}',
    hint: 'คัดลอกรีวิวของคุณ แล้วเปิดหน้าร้าน',
    noLink: 'ยังไม่ได้ตั้งลิงก์รีวิว',
    pasteCopied: 'คัดลอกแล้ว แตะ "เขียนรีวิว" ที่ {place} แล้ววาง',
    pasteManual: 'เลือกรีวิวแล้วคัดลอก จากนั้นแตะ "เขียนรีวิว" ที่ {place}',
    nothingToCopy: 'ยังไม่มีอะไรให้คัดลอก',
    languageChanged: 'รีวิวถัดไปจะเขียนเป็นภาษานั้น',
    lastTry: 'นี่เป็นอันสุดท้ายในตอนนี้ แก้ไขได้ตามต้องการ',
    triesOne: 'เหลืออีก {n} ครั้งในตอนนี้',
    triesMany: 'เหลืออีก {n} ครั้งในตอนนี้',
    loadFailed: 'โหลดการตั้งค่าของหน้านี้ไม่สำเร็จ',
    writerFailed: 'ติดต่อระบบเขียนรีวิวไม่ได้ ลองอีกครั้ง',
    noKey: 'ยังไม่ได้ตั้งคีย์ OpenRouter กรุณาเพิ่มในการตั้งค่า',
    tooFast: 'รีวิวถี่เกินไป รอสักครู่แล้วลองใหม่',
    outOfTries:
      'ใช้จำนวนรีวิวที่มีครบแล้วในตอนนี้ แก้ไขรีวิวที่มีอยู่ได้ตามต้องการ เพราะเป็นของคุณ',
    writerDown: "ระบบเขียนรีวิวไม่พร้อมใช้งานในขณะนี้ ลองอีกครั้ง",
    writerEmpty: "ระบบเขียนรีวิวไม่ได้ส่งข้อความกลับมา ลองอีกครั้ง",
  },

  zh: {
    title: '写评价',
    heading: '感谢您的光临',
    lede: '这是用您的语气写的评价。您可以随意修改，然后发布。',
    picker: '哪里让您印象深刻？',
    browseMore: '浏览更多主题（{n}）',
    browseFewer: '收起主题',
    lengthLabel: '写多长？',
    lengthAny: '不限',
    lengthShort: '简短',
    lengthDetailed: '详细',
    reviewLabel: '您的评价',
    placeholder: '评价将显示在这里。',
    regenerate: '重新生成',
    regenerateCount: '重新生成（{used}/{max}）',
    copy: '复制',
    copied: '已复制',
    language: '语言',
    proceed: '前往 {place}',
    hint: '复制评价后会打开商家页面。',
    noLink: '尚未设置评价链接。',
    pasteCopied: '已复制。在 {place} 点击「写评价」，然后粘贴。',
    pasteManual: '请选中评价并复制，然后在 {place} 点击「写评价」。',
    nothingToCopy: '还没有可复制的内容。',
    languageChanged: '下一条将用该语言书写。',
    lastTry: '这是目前的最后一条。您可以随意修改。',
    triesOne: '目前还剩 {n} 次。',
    triesMany: '目前还剩 {n} 次。',
    loadFailed: '无法加载页面设置。',
    writerFailed: '无法连接生成服务，请重试。',
    noKey: '尚未设置 OpenRouter 密钥，请在设置中添加。',
    tooFast: '操作过于频繁，请稍候再试。',
    outOfTries: '目前的次数已用完。您可以修改现有的评价，它是您的。',
    writerDown: "生成服务暂时不可用，请重试。",
    writerEmpty: "生成服务没有返回内容，请重试。",
  },

  ja: {
    title: 'レビューを書く',
    heading: 'ご利用ありがとうございました',
    lede: 'あなたの言葉で書いたレビューです。自由に編集して投稿してください。',
    picker: '印象に残ったことは?',
    browseMore: '他の項目を見る ({n})',
    browseFewer: '項目を減らす',
    lengthLabel: '長さは?',
    lengthAny: 'おまかせ',
    lengthShort: '短め',
    lengthDetailed: '詳しく',
    reviewLabel: 'あなたのレビュー',
    placeholder: 'レビューがここに表示されます。',
    regenerate: '作り直す',
    regenerateCount: '作り直す ({used}/{max})',
    copy: 'コピー',
    copied: 'コピーしました',
    language: '言語',
    proceed: '{place} に進む',
    hint: 'レビューをコピーして掲載ページを開きます。',
    noLink: 'レビューのリンクが未設定です。',
    pasteCopied:
      'コピーしました。{place} で「クチコミを書く」を押して貼り付けてください。',
    pasteManual:
      'レビューを選択してコピーし、{place} で「クチコミを書く」を押してください。',
    nothingToCopy: 'まだコピーするものがありません。',
    languageChanged: '次回はその言語で作成します。',
    lastTry: '今回はこれで最後です。自由に編集してください。',
    triesOne: '残り {n} 回です。',
    triesMany: '残り {n} 回です。',
    loadFailed: 'ページの設定を読み込めませんでした。',
    writerFailed: '生成サービスに接続できません。もう一度お試しください。',
    noKey: 'OpenRouter のキーが未設定です。設定から追加してください。',
    tooFast: '回数が多すぎます。少し待ってからお試しください。',
    outOfTries:
      '今回分のレビューをすべて使いました。今あるものを自由に編集してください。',
    writerDown: "生成サービスは現在利用できません。もう一度お試しください。",
    writerEmpty: "生成サービスから何も返りませんでした。もう一度お試しください。",
  },

  ko: {
    title: '리뷰 작성',
    heading: '이용해 주셔서 감사합니다',
    lede: '당신의 표현으로 쓴 리뷰입니다. 원하는 대로 수정한 뒤 게시하세요.',
    picker: '무엇이 좋았나요?',
    browseMore: '다른 주제 보기 ({n})',
    browseFewer: '주제 접기',
    lengthLabel: '길이는요?',
    lengthAny: '상관없음',
    lengthShort: '짧게',
    lengthDetailed: '자세히',
    reviewLabel: '내 리뷰',
    placeholder: '리뷰가 여기에 표시됩니다.',
    regenerate: '다시 생성',
    regenerateCount: '다시 생성 ({used}/{max})',
    copy: '복사',
    copied: '복사됨',
    language: '언어',
    proceed: '{place}(으)로 이동',
    hint: '리뷰를 복사한 뒤 등록 페이지를 엽니다.',
    noLink: '리뷰 링크가 아직 없습니다.',
    pasteCopied: '복사했습니다. {place}에서 "리뷰 쓰기"를 누른 뒤 붙여넣으세요.',
    pasteManual: '리뷰를 선택해 복사한 뒤 {place}에서 "리뷰 쓰기"를 누르세요.',
    nothingToCopy: '아직 복사할 내용이 없습니다.',
    languageChanged: '다음 리뷰는 해당 언어로 작성됩니다.',
    lastTry: '지금은 이것이 마지막입니다. 원하는 대로 수정하세요.',
    triesOne: '지금은 {n}번 남았습니다.',
    triesMany: '지금은 {n}번 남았습니다.',
    loadFailed: '페이지 설정을 불러오지 못했습니다.',
    writerFailed: '생성 서비스에 연결할 수 없습니다. 다시 시도해 주세요.',
    noKey: 'OpenRouter 키가 없습니다. 설정에서 추가하세요.',
    tooFast: '요청이 너무 잦습니다. 잠시 후 다시 시도하세요.',
    outOfTries:
      '지금 사용할 수 있는 횟수를 모두 썼습니다. 있는 리뷰를 자유롭게 수정하세요.',
    writerDown: "생성 서비스를 지금 사용할 수 없습니다. 다시 시도해 주세요.",
    writerEmpty: "생성 서비스가 빈 응답을 보냈습니다. 다시 시도해 주세요.",
  },

  es: {
    title: 'Escribir una reseña',
    heading: 'Gracias por tu visita',
    lede: 'Aquí tienes una reseña con tus palabras. Cámbiala como quieras y publícala.',
    picker: '¿Qué te llamó la atención?',
    browseMore: 'Ver más temas ({n})',
    browseFewer: 'Ver menos temas',
    lengthLabel: '¿Qué extensión?',
    lengthAny: 'Cualquiera',
    lengthShort: 'Corta',
    lengthDetailed: 'Detallada',
    reviewLabel: 'Tu reseña',
    placeholder: 'Tu reseña aparecerá aquí.',
    regenerate: 'Generar otra',
    regenerateCount: 'Generar otra ({used}/{max})',
    copy: 'Copiar',
    copied: 'Copiado',
    language: 'Idioma',
    proceed: 'Ir a {place}',
    hint: 'Copia tu reseña y abre la ficha.',
    noLink: 'Todavía no hay enlace de reseñas.',
    pasteCopied: 'Copiado. Pulsa "Escribir una reseña" en {place} y pega.',
    pasteManual:
      'Selecciona la reseña y cópiala, luego pulsa "Escribir una reseña" en {place}.',
    nothingToCopy: 'Todavía no hay nada que copiar.',
    languageChanged: 'La siguiente se escribirá en ese idioma.',
    lastTry: 'Esta es la última por ahora. Edítala como quieras.',
    triesOne: 'Queda {n} intento por ahora.',
    triesMany: 'Quedan {n} intentos por ahora.',
    loadFailed: 'No se pudo cargar la configuración de la página.',
    writerFailed: 'No se pudo conectar con el generador. Inténtalo de nuevo.',
    noKey: 'Todavía no hay clave de OpenRouter. Añade una en Ajustes.',
    tooFast: 'Son muchas reseñas seguidas. Espera un momento e inténtalo de nuevo.',
    outOfTries:
      'Has usado las reseñas disponibles por ahora. Edita la que tienes: es tuya.',
    writerDown: "El generador no está disponible ahora mismo. Inténtalo de nuevo.",
    writerEmpty: "El generador no devolvió nada. Inténtalo de nuevo.",
  },

  fr: {
    title: 'Laisser un avis',
    heading: 'Merci de votre visite',
    lede: 'Voici un avis dans vos mots. Modifiez ce que vous voulez, puis publiez.',
    picker: "Qu'est-ce qui vous a marqué ?",
    browseMore: 'Voir plus de thèmes ({n})',
    browseFewer: 'Voir moins de thèmes',
    lengthLabel: 'Quelle longueur ?',
    lengthAny: 'Peu importe',
    lengthShort: 'Court',
    lengthDetailed: 'Détaillé',
    reviewLabel: 'Votre avis',
    placeholder: 'Votre avis apparaîtra ici.',
    regenerate: 'Régénérer',
    regenerateCount: 'Régénérer ({used}/{max})',
    copy: 'Copier',
    copied: 'Copié',
    language: 'Langue',
    proceed: 'Aller sur {place}',
    hint: 'Copie votre avis, puis ouvre la fiche.',
    noLink: "Aucun lien d'avis pour le moment.",
    pasteCopied: 'Copié. Touchez « Rédiger un avis » sur {place}, puis collez.',
    pasteManual:
      "Sélectionnez l'avis et copiez-le, puis touchez « Rédiger un avis » sur {place}.",
    nothingToCopy: 'Rien à copier pour le moment.',
    languageChanged: 'Le prochain sera écrit dans cette langue.',
    lastTry: "C'est le dernier pour le moment. Modifiez-le comme vous voulez.",
    triesOne: 'Il reste {n} essai pour le moment.',
    triesMany: 'Il reste {n} essais pour le moment.',
    loadFailed: 'Impossible de charger les paramètres de la page.',
    writerFailed: 'Impossible de joindre le générateur. Réessayez.',
    noKey: "Aucune clé OpenRouter pour l'instant. Ajoutez-en une dans les réglages.",
    tooFast: "Cela fait beaucoup d'avis. Patientez un instant et réessayez.",
    outOfTries:
      "Vous avez utilisé les avis disponibles pour le moment. Modifiez celui que vous avez : il est à vous.",
    writerDown: "Le générateur est indisponible pour le moment. Réessayez.",
    writerEmpty: "Le générateur n'a rien renvoyé. Réessayez.",
  },

  de: {
    title: 'Bewertung schreiben',
    heading: 'Danke für Ihren Besuch',
    lede: 'Hier ist eine Bewertung in Ihren Worten. Ändern Sie sie beliebig und posten Sie sie.',
    picker: 'Was ist Ihnen aufgefallen?',
    browseMore: 'Weitere Themen ansehen ({n})',
    browseFewer: 'Weniger Themen anzeigen',
    lengthLabel: 'Wie lang?',
    lengthAny: 'Egal',
    lengthShort: 'Kurz',
    lengthDetailed: 'Ausführlich',
    reviewLabel: 'Ihre Bewertung',
    placeholder: 'Ihre Bewertung erscheint hier.',
    regenerate: 'Neu erstellen',
    regenerateCount: 'Neu erstellen ({used}/{max})',
    copy: 'Kopieren',
    copied: 'Kopiert',
    language: 'Sprache',
    proceed: 'Weiter zu {place}',
    hint: 'Kopiert Ihre Bewertung und öffnet den Eintrag.',
    noLink: 'Noch kein Bewertungslink hinterlegt.',
    pasteCopied:
      'Kopiert. Tippen Sie bei {place} auf „Rezension schreiben“ und fügen Sie ein.',
    pasteManual:
      'Markieren und kopieren Sie die Bewertung, dann tippen Sie bei {place} auf „Rezension schreiben“.',
    nothingToCopy: 'Noch nichts zum Kopieren da.',
    languageChanged: 'Die nächste wird in dieser Sprache geschrieben.',
    lastTry: 'Das war die letzte für den Moment. Ändern Sie sie beliebig.',
    triesOne: 'Noch {n} Versuch für den Moment.',
    triesMany: 'Noch {n} Versuche für den Moment.',
    loadFailed: 'Die Seiteneinstellungen konnten nicht geladen werden.',
    writerFailed: 'Der Generator ist nicht erreichbar. Bitte erneut versuchen.',
    noKey: 'Noch kein OpenRouter-Schlüssel. Fügen Sie einen in den Einstellungen hinzu.',
    tooFast: 'Das sind viele Bewertungen. Warten Sie kurz und versuchen Sie es erneut.',
    outOfTries:
      'Sie haben die vorerst verfügbaren Bewertungen aufgebraucht. Bearbeiten Sie die vorhandene — sie gehört Ihnen.',
    writerDown: "Der Generator ist gerade nicht verfügbar. Bitte erneut versuchen.",
    writerEmpty: "Der Generator hat nichts zurückgegeben. Bitte erneut versuchen.",
  },

  it: {
    title: 'Scrivi una recensione',
    heading: 'Grazie della visita',
    lede: 'Ecco una recensione con le tue parole. Modificala come vuoi e pubblicala.',
    picker: 'Cosa ti ha colpito?',
    browseMore: 'Vedi altri temi ({n})',
    browseFewer: 'Mostra meno temi',
    lengthLabel: 'Quanto lunga?',
    lengthAny: 'Indifferente',
    lengthShort: 'Breve',
    lengthDetailed: 'Dettagliata',
    reviewLabel: 'La tua recensione',
    placeholder: 'La tua recensione apparirà qui.',
    regenerate: 'Rigenera',
    regenerateCount: 'Rigenera ({used}/{max})',
    copy: 'Copia',
    copied: 'Copiato',
    language: 'Lingua',
    proceed: 'Vai su {place}',
    hint: 'Copia la recensione e apre la scheda.',
    noLink: 'Nessun link alle recensioni.',
    pasteCopied: 'Copiato. Tocca "Scrivi una recensione" su {place}, poi incolla.',
    pasteManual:
      'Seleziona la recensione e copiala, poi tocca "Scrivi una recensione" su {place}.',
    nothingToCopy: 'Non c’è ancora nulla da copiare.',
    languageChanged: 'La prossima sarà scritta in quella lingua.',
    lastTry: 'Per ora è l’ultima. Modificala come preferisci.',
    triesOne: 'Resta {n} tentativo per ora.',
    triesMany: 'Restano {n} tentativi per ora.',
    loadFailed: 'Impossibile caricare le impostazioni della pagina.',
    writerFailed: 'Impossibile raggiungere il generatore. Riprova.',
    noKey: 'Nessuna chiave OpenRouter. Aggiungine una nelle impostazioni.',
    tooFast: 'Sono molte recensioni. Attendi un momento e riprova.',
    outOfTries:
      'Hai usato le recensioni disponibili per ora. Modifica quella che hai: è tua.',
    writerDown: "Il generatore non è disponibile in questo momento. Riprova.",
    writerEmpty: "Il generatore non ha restituito nulla. Riprova.",
  },

  pt: {
    title: 'Escrever uma avaliação',
    heading: 'Obrigado pela sua visita',
    lede: 'Aqui está uma avaliação com as suas palavras. Altere o que quiser e publique.',
    picker: 'O que se destacou?',
    browseMore: 'Ver mais temas ({n})',
    browseFewer: 'Ver menos temas',
    lengthLabel: 'Que tamanho?',
    lengthAny: 'Tanto faz',
    lengthShort: 'Curta',
    lengthDetailed: 'Detalhada',
    reviewLabel: 'A sua avaliação',
    placeholder: 'A sua avaliação aparecerá aqui.',
    regenerate: 'Gerar outra',
    regenerateCount: 'Gerar outra ({used}/{max})',
    copy: 'Copiar',
    copied: 'Copiado',
    language: 'Idioma',
    proceed: 'Ir para {place}',
    hint: 'Copia a avaliação e abre a página.',
    noLink: 'Ainda sem link de avaliações.',
    pasteCopied: 'Copiado. Toque em "Escrever avaliação" em {place} e cole.',
    pasteManual:
      'Selecione a avaliação e copie, depois toque em "Escrever avaliação" em {place}.',
    nothingToCopy: 'Ainda não há nada para copiar.',
    languageChanged: 'A próxima será escrita nesse idioma.',
    lastTry: 'Por agora é a última. Edite-a como quiser.',
    triesOne: 'Resta {n} tentativa por agora.',
    triesMany: 'Restam {n} tentativas por agora.',
    loadFailed: 'Não foi possível carregar as definições da página.',
    writerFailed: 'Não foi possível contactar o gerador. Tente novamente.',
    noKey: 'Ainda sem chave OpenRouter. Adicione uma nas definições.',
    tooFast: 'São muitas avaliações seguidas. Aguarde um momento e tente novamente.',
    outOfTries:
      'Usou as avaliações disponíveis por agora. Edite a que tem — é sua.',
    writerDown: "O gerador está indisponível neste momento. Tente novamente.",
    writerEmpty: "O gerador não devolveu nada. Tente novamente.",
  },

  nl: {
    title: 'Een review schrijven',
    heading: 'Bedankt voor je bezoek',
    lede: 'Dit is een review in jouw woorden. Pas aan wat je wilt en plaats hem.',
    picker: 'Wat viel je op?',
    browseMore: 'Meer onderwerpen bekijken ({n})',
    browseFewer: 'Minder onderwerpen tonen',
    lengthLabel: 'Hoe lang?',
    lengthAny: 'Maakt niet uit',
    lengthShort: 'Kort',
    lengthDetailed: 'Uitgebreid',
    reviewLabel: 'Jouw review',
    placeholder: 'Je review komt hier te staan.',
    regenerate: 'Opnieuw',
    regenerateCount: 'Opnieuw ({used}/{max})',
    copy: 'Kopiëren',
    copied: 'Gekopieerd',
    language: 'Taal',
    proceed: 'Naar {place}',
    hint: 'Kopieert je review en opent de pagina.',
    noLink: 'Nog geen reviewlink ingesteld.',
    pasteCopied: 'Gekopieerd. Tik bij {place} op "Een review schrijven" en plak.',
    pasteManual:
      'Selecteer de review en kopieer hem, tik dan bij {place} op "Een review schrijven".',
    nothingToCopy: 'Nog niets om te kopiëren.',
    languageChanged: 'De volgende wordt in die taal geschreven.',
    lastTry: 'Dit is voorlopig de laatste. Pas hem aan zoals je wilt.',
    triesOne: 'Nog {n} poging voorlopig.',
    triesMany: 'Nog {n} pogingen voorlopig.',
    loadFailed: 'Kon de pagina-instellingen niet laden.',
    writerFailed: 'Kan de generator niet bereiken. Probeer het opnieuw.',
    noKey: 'Nog geen OpenRouter-sleutel. Voeg er een toe in de instellingen.',
    tooFast: 'Dat zijn veel reviews. Wacht even en probeer het opnieuw.',
    outOfTries:
      'Je hebt de beschikbare reviews voorlopig gebruikt. Pas de review die je hebt gerust aan — hij is van jou.',
    writerDown: "De generator is nu niet beschikbaar. Probeer het opnieuw.",
    writerEmpty: "De generator gaf niets terug. Probeer het opnieuw.",
  },
};

const FALLBACK = 'en';

/** Every key English has. Another language missing one is a bug, not a gap. */
const KEYS = Object.keys(STRINGS[FALLBACK]);

/**
 * One string, filled in.
 *
 * Falls back to English per key rather than per language: a language added with
 * two keys shows those two and English for the rest, which beats showing
 * English for all of it. An unknown key returns its own name — visible in
 * testing, harmless in front of a guest, and never blank.
 *
 * @param {string} lang - a language code from config.js's LANGUAGES
 * @param {string} key
 * @param {Record<string, string|number>} [vars] - fills {braced} placeholders
 */
function t(lang, key, vars = {}) {
  const table = STRINGS[lang] || STRINGS[FALLBACK];
  const raw = table[key] ?? STRINGS[FALLBACK][key] ?? key;
  return raw.replace(/\{(\w+)\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole
  );
}

/**
 * The best language for a guest we have not heard from yet.
 *
 * For the errors that happen before the page has a selector — an address
 * belonging to no business, say. Matched on the base tag, so zh-CN, zh-TW and
 * zh are one offer here, and q-values are ignored: a header in preference order
 * is close enough for one sentence.
 *
 * @param {string} header - the raw Accept-Language header
 * @param {string[]} [offered] - codes the page actually has
 */
function fromHeader(header, offered = Object.keys(STRINGS)) {
  const known = new Set(offered);
  for (const part of String(header || '').split(',')) {
    const base = part.split(';')[0].trim().toLowerCase().split('-')[0];
    if (known.has(base)) return base;
  }
  return FALLBACK;
}

/**
 * The whole table as a script the page can load.
 *
 * A script rather than JSON so it costs no fetch of its own, and every language
 * at once because the selector has to switch the page instantly — a table of
 * short strings gzips to a few kilobytes, which is cheaper than a round trip.
 *
 * Built once at boot: it cannot change without a deploy, so rebuilding it per
 * request would be work done on every guest's first paint for nothing.
 */
const SCRIPT = `window.RS_STRINGS=${JSON.stringify(STRINGS)};`;

module.exports = { STRINGS, KEYS, FALLBACK, t, fromHeader, SCRIPT };
