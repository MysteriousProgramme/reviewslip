'use strict';

/**
 * Guest languages.
 *
 * Two jobs, and the second matters more: the page's own text, and the language
 * the review is *written* in. A Chinese guest reading a translated page is no
 * better off if the review they are handed is in English — they cannot judge it,
 * and they are about to post it publicly under their own name.
 *
 * `name` is in the language itself. A selector that lists "Chinese" is useless
 * to someone who cannot read English; it has to say 中文.
 *
 * `prompt` is the English name of the language, because that is what goes into
 * the instruction the model reads.
 *
 * Category labels are not here. A business writes its own ("Rooms", "The Bar"),
 * so they are its words rather than ours — translating them would need a model
 * call per language per business. The built-in set is translated below under
 * `categories`, and a business that has written its own keeps them as authored.
 */

const DEFAULT_LANG = 'en';

const LANGUAGES = {
  en: {
    name: 'English',
    prompt: 'English',
    ui: {
      lede: "Here's a review in your words. Change anything you like, then post it.",
      picker: 'What stood out?',
      review: 'Your review',
      placeholder: 'Your review will appear here.',
      regenerate: 'Regenerate',
      copy: 'Copy',
      copied: 'Copied',
      google: 'Proceed to Google',
      tripadvisor: 'Proceed to Tripadvisor',
      hint: 'Copies your review, then opens the listing.',
      noLink: 'No review link set yet.',
      language: 'Language',
    },
    categories: {
      any: 'Any',
      restaurant: 'Restaurant',
      common: 'Common Area',
      bar: 'Bar',
      rooms: 'Rooms',
    },
  },

  zh: {
    name: '中文',
    prompt: 'Simplified Chinese',
    ui: {
      lede: '这是用您的语气写的评价。您可以随意修改，然后发布。',
      picker: '哪里让您印象深刻？',
      review: '您的评价',
      placeholder: '评价将显示在这里。',
      regenerate: '重新生成',
      copy: '复制',
      copied: '已复制',
      google: '前往 Google 发布',
      tripadvisor: '前往 Tripadvisor 发布',
      hint: '复制评价后会打开商家页面。',
      noLink: '尚未设置评价链接。',
      language: '语言',
    },
    categories: {
      any: '综合',
      restaurant: '餐厅',
      common: '公共区域',
      bar: '酒吧',
      rooms: '客房',
    },
  },

  th: {
    name: 'ไทย',
    prompt: 'Thai',
    ui: {
      lede: 'นี่คือรีวิวในคำพูดของคุณ แก้ไขได้ตามต้องการ แล้วโพสต์เลย',
      picker: 'อะไรที่ประทับใจคุณ?',
      review: 'รีวิวของคุณ',
      placeholder: 'รีวิวของคุณจะปรากฏที่นี่',
      regenerate: 'สร้างใหม่',
      copy: 'คัดลอก',
      copied: 'คัดลอกแล้ว',
      google: 'ไปที่ Google',
      tripadvisor: 'ไปที่ Tripadvisor',
      hint: 'คัดลอกรีวิวของคุณ แล้วเปิดหน้าร้าน',
      noLink: 'ยังไม่ได้ตั้งลิงก์รีวิว',
      language: 'ภาษา',
    },
    categories: {
      any: 'ทั่วไป',
      restaurant: 'ร้านอาหาร',
      common: 'พื้นที่ส่วนกลาง',
      bar: 'บาร์',
      rooms: 'ห้องพัก',
    },
  },

  ja: {
    name: '日本語',
    prompt: 'Japanese',
    ui: {
      lede: 'あなたの言葉で書いたレビューです。自由に編集して投稿してください。',
      picker: '印象に残ったことは?',
      review: 'あなたのレビュー',
      placeholder: 'レビューがここに表示されます。',
      regenerate: '作り直す',
      copy: 'コピー',
      copied: 'コピーしました',
      google: 'Google に進む',
      tripadvisor: 'Tripadvisor に進む',
      hint: 'レビューをコピーして掲載ページを開きます。',
      noLink: 'レビューのリンクが未設定です。',
      language: '言語',
    },
    categories: {
      any: '全体',
      restaurant: 'レストラン',
      common: '共用スペース',
      bar: 'バー',
      rooms: '客室',
    },
  },

  ko: {
    name: '한국어',
    prompt: 'Korean',
    ui: {
      lede: '당신의 표현으로 쓴 리뷰입니다. 원하는 대로 수정한 뒤 게시하세요.',
      picker: '무엇이 좋았나요?',
      review: '내 리뷰',
      placeholder: '리뷰가 여기에 표시됩니다.',
      regenerate: '다시 생성',
      copy: '복사',
      copied: '복사됨',
      google: 'Google로 이동',
      tripadvisor: 'Tripadvisor로 이동',
      hint: '리뷰를 복사한 뒤 등록 페이지를 엽니다.',
      noLink: '리뷰 링크가 아직 없습니다.',
      language: '언어',
    },
    categories: {
      any: '전체',
      restaurant: '레스토랑',
      common: '공용 공간',
      bar: '바',
      rooms: '객실',
    },
  },

  es: {
    name: 'Español',
    prompt: 'Spanish',
    ui: {
      lede: 'Aquí tienes una reseña con tus palabras. Cámbiala como quieras y publícala.',
      picker: '¿Qué te llamó la atención?',
      review: 'Tu reseña',
      placeholder: 'Tu reseña aparecerá aquí.',
      regenerate: 'Generar otra',
      copy: 'Copiar',
      copied: 'Copiado',
      google: 'Ir a Google',
      tripadvisor: 'Ir a Tripadvisor',
      hint: 'Copia tu reseña y abre la ficha.',
      noLink: 'Todavía no hay enlace de reseñas.',
      language: 'Idioma',
    },
    categories: {
      any: 'General',
      restaurant: 'Restaurante',
      common: 'Zonas comunes',
      bar: 'Bar',
      rooms: 'Habitaciones',
    },
  },

  fr: {
    name: 'Français',
    prompt: 'French',
    ui: {
      lede: 'Voici un avis dans vos mots. Modifiez ce que vous voulez, puis publiez.',
      picker: "Qu'est-ce qui vous a marqué ?",
      review: 'Votre avis',
      placeholder: 'Votre avis apparaîtra ici.',
      regenerate: 'Régénérer',
      copy: 'Copier',
      copied: 'Copié',
      google: 'Aller sur Google',
      tripadvisor: 'Aller sur Tripadvisor',
      hint: "Copie votre avis, puis ouvre la fiche.",
      noLink: "Aucun lien d'avis pour le moment.",
      language: 'Langue',
    },
    categories: {
      any: 'Général',
      restaurant: 'Restaurant',
      common: 'Espaces communs',
      bar: 'Bar',
      rooms: 'Chambres',
    },
  },

  de: {
    name: 'Deutsch',
    prompt: 'German',
    ui: {
      lede: 'Hier ist eine Bewertung in Ihren Worten. Ändern Sie sie beliebig und posten Sie sie.',
      picker: 'Was ist Ihnen aufgefallen?',
      review: 'Ihre Bewertung',
      placeholder: 'Ihre Bewertung erscheint hier.',
      regenerate: 'Neu erstellen',
      copy: 'Kopieren',
      copied: 'Kopiert',
      google: 'Weiter zu Google',
      tripadvisor: 'Weiter zu Tripadvisor',
      hint: 'Kopiert Ihre Bewertung und öffnet den Eintrag.',
      noLink: 'Noch kein Bewertungslink hinterlegt.',
      language: 'Sprache',
    },
    categories: {
      any: 'Allgemein',
      restaurant: 'Restaurant',
      common: 'Gemeinschaftsbereiche',
      bar: 'Bar',
      rooms: 'Zimmer',
    },
  },

  it: {
    name: 'Italiano',
    prompt: 'Italian',
    ui: {
      lede: 'Ecco una recensione con le tue parole. Modificala come vuoi e pubblicala.',
      picker: 'Cosa ti ha colpito?',
      review: 'La tua recensione',
      placeholder: 'La tua recensione apparirà qui.',
      regenerate: 'Rigenera',
      copy: 'Copia',
      copied: 'Copiato',
      google: 'Vai su Google',
      tripadvisor: 'Vai su Tripadvisor',
      hint: 'Copia la recensione e apre la scheda.',
      noLink: 'Nessun link alle recensioni.',
      language: 'Lingua',
    },
    categories: {
      any: 'Generale',
      restaurant: 'Ristorante',
      common: 'Aree comuni',
      bar: 'Bar',
      rooms: 'Camere',
    },
  },

  pt: {
    name: 'Português',
    prompt: 'Portuguese',
    ui: {
      lede: 'Aqui está uma avaliação com as suas palavras. Altere o que quiser e publique.',
      picker: 'O que se destacou?',
      review: 'A sua avaliação',
      placeholder: 'A sua avaliação aparecerá aqui.',
      regenerate: 'Gerar outra',
      copy: 'Copiar',
      copied: 'Copiado',
      google: 'Ir para o Google',
      tripadvisor: 'Ir para o Tripadvisor',
      hint: 'Copia a avaliação e abre a página.',
      noLink: 'Ainda sem link de avaliações.',
      language: 'Idioma',
    },
    categories: {
      any: 'Geral',
      restaurant: 'Restaurante',
      common: 'Áreas comuns',
      bar: 'Bar',
      rooms: 'Quartos',
    },
  },

  nl: {
    name: 'Nederlands',
    prompt: 'Dutch',
    ui: {
      lede: 'Dit is een review in jouw woorden. Pas aan wat je wilt en plaats hem.',
      picker: 'Wat viel je op?',
      review: 'Jouw review',
      placeholder: 'Je review komt hier te staan.',
      regenerate: 'Opnieuw',
      copy: 'Kopiëren',
      copied: 'Gekopieerd',
      google: 'Naar Google',
      tripadvisor: 'Naar Tripadvisor',
      hint: 'Kopieert je review en opent de pagina.',
      noLink: 'Nog geen reviewlink ingesteld.',
      language: 'Taal',
    },
    categories: {
      any: 'Algemeen',
      restaurant: 'Restaurant',
      common: 'Gemeenschappelijke ruimtes',
      bar: 'Bar',
      rooms: 'Kamers',
    },
  },

  hi: {
    name: 'हिन्दी',
    prompt: 'Hindi',
    ui: {
      lede: 'यह आपके शब्दों में एक समीक्षा है। जो चाहें बदलें, फिर पोस्ट करें।',
      picker: 'क्या ख़ास लगा?',
      review: 'आपकी समीक्षा',
      placeholder: 'आपकी समीक्षा यहाँ दिखेगी।',
      regenerate: 'दोबारा बनाएँ',
      copy: 'कॉपी करें',
      copied: 'कॉपी हो गया',
      google: 'Google पर जाएँ',
      tripadvisor: 'Tripadvisor पर जाएँ',
      hint: 'समीक्षा कॉपी करके पेज खोलता है।',
      noLink: 'अभी कोई समीक्षा लिंक नहीं है।',
      language: 'भाषा',
    },
    categories: {
      any: 'सामान्य',
      restaurant: 'रेस्टोरेंट',
      common: 'साझा जगह',
      bar: 'बार',
      rooms: 'कमरे',
    },
  },

  ru: {
    name: 'Русский',
    prompt: 'Russian',
    ui: {
      lede: 'Вот отзыв вашими словами. Измените что угодно и опубликуйте.',
      picker: 'Что запомнилось?',
      review: 'Ваш отзыв',
      placeholder: 'Ваш отзыв появится здесь.',
      regenerate: 'Создать ещё',
      copy: 'Копировать',
      copied: 'Скопировано',
      google: 'Перейти в Google',
      tripadvisor: 'Перейти в Tripadvisor',
      hint: 'Скопирует отзыв и откроет страницу.',
      noLink: 'Ссылка на отзывы не задана.',
      language: 'Язык',
    },
    categories: {
      any: 'Общее',
      restaurant: 'Ресторан',
      common: 'Общие зоны',
      bar: 'Бар',
      rooms: 'Номера',
    },
  },

  ar: {
    name: 'العربية',
    prompt: 'Arabic',
    rtl: true,
    ui: {
      lede: 'هذه مراجعة بكلماتك. عدّل ما تريد ثم انشرها.',
      picker: 'ما الذي أعجبك؟',
      review: 'مراجعتك',
      placeholder: 'ستظهر مراجعتك هنا.',
      regenerate: 'إنشاء مرة أخرى',
      copy: 'نسخ',
      copied: 'تم النسخ',
      google: 'المتابعة إلى Google',
      tripadvisor: 'المتابعة إلى Tripadvisor',
      hint: 'ينسخ مراجعتك ثم يفتح الصفحة.',
      noLink: 'لا يوجد رابط للمراجعات بعد.',
      language: 'اللغة',
    },
    categories: {
      any: 'عام',
      restaurant: 'المطعم',
      common: 'المناطق المشتركة',
      bar: 'البار',
      rooms: 'الغرف',
    },
  },
};

function isLang(code) {
  return Object.prototype.hasOwnProperty.call(LANGUAGES, code);
}

/** Unknown codes fall back to English rather than leaving a page blank. */
function langFor(code) {
  return LANGUAGES[isLang(code) ? code : DEFAULT_LANG];
}

/** Just enough for the selector: code and the name in that language. */
function list() {
  return Object.entries(LANGUAGES).map(([code, lang]) => ({
    code,
    name: lang.name,
  }));
}

/**
 * A business's categories in the guest's language.
 *
 * Only the built-in ids are translated. A business that wrote its own buttons
 * keeps its own words — they are its voice, and guessing at a translation would
 * be worse than showing what it actually wrote.
 */
function localiseCategories(categories, code) {
  const dict = langFor(code).categories;
  return categories.map((c) => ({
    ...c,
    label: dict[c.id] || c.label,
  }));
}

module.exports = {
  DEFAULT_LANG,
  LANGUAGES,
  isLang,
  langFor,
  list,
  localiseCategories,
};
