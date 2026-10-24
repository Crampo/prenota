// Logica delle prenotazioni FunLab Vela.
// Lo stesso file gira nel browser (modalità prova) e dentro Apps Script (Code.gs).
var Core = (function () {
  var cfg = {
    dayKey: function (d) {
      return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
    },
    makeDate: function (day, time) { return new Date(day + 'T' + (time || '00:00') + ':00'); }
  };
  function configure(o) { for (var k in o) cfg[k] = o[k]; }

  var CORSI = ['Base', 'Avanzato', 'Evento'];
  var CORSI_PACCHETTO = ['Base', 'Avanzato'];
  // Attivo: frequenta. Non attivo: ha finito o è in pausa, nessuna comunicazione.
  // Interessato: non frequenta ma riceve eventi e newsletter. Spento: nessuna comunicazione e niente accesso.
  var STATI = ['Attivo', 'Non attivo', 'Interessato', 'Spento'];
  var PREFERENZE = ['Indifferente', 'Feriali', 'Weekend'];
  function statoOf(a) { return STATI.indexOf(a.Stato) >= 0 ? a.Stato : 'Attivo'; }
  function prefOf(a) { return PREFERENZE.indexOf(a.Preferenza) >= 0 ? a.Preferenza : 'Indifferente'; }

  function uid() { return Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-5); }
  function newToken() { var s = ''; while (s.length < 20) s += Math.random().toString(36).slice(2); return s.slice(0, 20); }
  function num(v) { var n = Number(v); return isNaN(n) ? 0 : n; }
  function hoursUntil(d, now) { return (new Date(d).getTime() - now.getTime()) / 36e5; }
  function byId(list, id) { for (var i = 0; i < list.length; i++) if (list[i].ID === id) return list[i]; return null; }
  function fail(msg) { throw new Error(msg); }
  function touch(db, table) { db.dirty = db.dirty || {}; db.dirty[table] = true; }
  function shiftDay(day, n) {
    var p = day.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
    return d.toISOString().slice(0, 10);
  }
  function normalizePhone(s) {
    var d = String(s || '').replace(/\D/g, '');
    if (d.indexOf('00') === 0) d = d.slice(2);
    if (d.length === 10 && d.charAt(0) === '3') d = '39' + d;
    return d;
  }

  // Una prenotazione occupa un posto (e un'uscita del pacchetto) se è richiesta o confermata
  // e la lezione non è stata annullata.
  function occupies(db, p) {
    if (p.Stato !== 'Richiesta' && p.Stato !== 'Confermata') return false;
    var l = byId(db.lezioni, p.LezioneID);
    return !!l && l.Stato !== 'Annullata';
  }

  function lessonInfo(db, l, now) {
    var ps = db.prenotazioni.filter(function (p) { return p.LezioneID === l.ID; });
    var occ = ps.filter(function (p) { return occupies(db, p); });
    var richieste = occ.filter(function (p) { return p.Stato === 'Richiesta'; }).length;
    var confermati = occ.filter(function (p) { return p.Stato === 'Confermata'; }).length;
    var tot = num(l.Posti) + num(l.PostiExtra);
    var ore = hoursUntil(l.Inizio, now);
    var stato;
    if (l.Stato === 'Annullata') stato = 'annullata';
    else if (l.Corso === 'Evento') stato = 'evento';
    else if (richieste > 0) stato = 'richiesta';
    else if (l.Stato === 'Individuale') stato = 'individuale';
    else if (confermati === 1) stato = 'uno';
    else if (confermati >= 2) stato = 'completa';
    else stato = 'libera';
    return {
      ID: l.ID, Inizio: l.Inizio, DurataOre: num(l.DurataOre), Corso: l.Corso, Stato: l.Stato, Motivo: l.Motivo || '', Note: l.Note || '',
      Posti: num(l.Posti), PostiExtra: num(l.PostiExtra), PostiTotali: tot,
      Occupati: occ.length, Richieste: richieste, Confermati: confermati, Liberi: tot - occ.length,
      Ore: ore, Semaforo: stato, Prenotazioni: ps,
      DaDecidere: l.Stato === 'Aperta' && l.Corso !== 'Evento' && ore >= 0 && ore <= 48 && confermati < 2,
      Prenotabile: l.Stato === 'Aperta' && l.Corso !== 'Evento' && ore > 48 && tot - occ.length > 0
    };
  }

  function packages(db, allievoId, now) {
    var today = cfg.dayKey(now);
    return db.pacchetti.filter(function (k) { return k.AllievoID === allievoId; }).map(function (k) {
      var usate = db.prenotazioni.filter(function (p) { return p.PacchettoID === k.ID && occupies(db, p); }).length;
      var rim = num(k.Uscite) - usate;
      var scad = k.Scadenza ? cfg.dayKey(k.Scadenza) : '9999-12-31';
      return {
        ID: k.ID, Corso: k.Corso, Uscite: num(k.Uscite), Usate: usate, Rimanenti: Math.max(rim, 0),
        Scadenza: k.Scadenza || '', DataAcquisto: k.DataAcquisto || '', Note: k.Note || '',
        Scaduto: scad < today, Valido: rim > 0 && scad >= today
      };
    }).sort(function (a, b) { return String(cfg.dayKey(a.Scadenza || now)).localeCompare(cfg.dayKey(b.Scadenza || now)); });
  }

  function credits(packs) {
    var c = { Base: 0, Avanzato: 0 };
    packs.forEach(function (k) { if (k.Valido && c[k.Corso] !== undefined) c[k.Corso] += k.Rimanenti; });
    return c;
  }

  function lessonsDone(db, allievoId, now) {
    return db.prenotazioni.filter(function (p) {
      if (p.AllievoID !== allievoId || p.Stato !== 'Confermata') return false;
      var l = byId(db.lezioni, p.LezioneID);
      return l && l.Stato !== 'Annullata' && hoursUntil(l.Inizio, now) < 0;
    }).length;
  }

  function settingsPublic(db) {
    var s = db.impostazioni;
    return { NomeScuola: s.NomeScuola || 'Scuola di vela', TelefonoIstruttore: normalizePhone(s.TelefonoIstruttore), AvvisoStagione: s.AvvisoStagione || '', FineStagione: s.FineStagione || '' };
  }

  function studentView(db, me, now) {
    var packs = packages(db, me.ID, now);
    var cred = credits(packs);
    var mine = db.prenotazioni.filter(function (p) { return p.AllievoID === me.ID; });
    var lessons = db.lezioni.map(function (l) { return lessonInfo(db, l, now); });
    var myByLesson = {};
    mine.forEach(function (p) { if (occupies(db, p)) myByLesson[p.LezioneID] = p; });

    var list = lessons.filter(function (L) {
      return L.Ore > 0 && L.Stato !== 'Annullata' && (L.Liberi > 0 || myByLesson[L.ID]);
    }).map(function (L) {
      var my = myByLesson[L.ID];
      var reason = '';
      if (!my) {
        if (L.Corso === 'Evento') reason = 'evento';
        else if (!L.Prenotabile) reason = 'tardi';
        else if (!(cred[L.Corso] > 0)) reason = 'crediti';
      }
      return {
        ID: L.ID, Inizio: L.Inizio, DurataOre: L.DurataOre, Corso: L.Corso, Note: L.Note, Liberi: L.Liberi, PostiTotali: L.PostiTotali,
        Mia: my ? my.Stato : '', PuoiPrenotare: !my && L.Prenotabile && cred[L.Corso] > 0, Motivo: reason
      };
    }).sort(function (a, b) { return new Date(a.Inizio) - new Date(b.Inizio); });

    var bookings = mine.map(function (p) {
      var l = byId(db.lezioni, p.LezioneID);
      if (!l) return null;
      var ore = hoursUntil(l.Inizio, now);
      if (ore < -6) return null;
      var occ = occupies(db, p);
      var stato = l.Stato === 'Annullata' && (p.Stato === 'Richiesta' || p.Stato === 'Confermata') ? 'Annullata dalla scuola' : p.Stato;
      return { ID: p.ID, Inizio: l.Inizio, Corso: l.Corso, Stato: stato, Motivo: l.Motivo || '', PuoiDisdire: occ && ore > 48, Tardi: occ && ore <= 48 && ore > 0 };
    }).filter(Boolean).filter(function (b) { return b.Stato !== 'Disdetta' && b.Stato !== 'Rifiutata'; })
      .sort(function (a, b) { return new Date(a.Inizio) - new Date(b.Inizio); });

    return {
      me: { Nome: me.Nome, Preferenza: prefOf(me), NotePreferenze: me.NotePreferenze || '', Crediti: cred, Fatte: lessonsDone(db, me.ID, now), Pacchetti: packs.filter(function (k) { return !k.Scaduto || k.Rimanenti > 0; }) },
      lezioni: list, prenotazioni: bookings, impostazioni: settingsPublic(db)
    };
  }

  function adminView(db, now) {
    var today = cfg.dayKey(now), tomorrow = shiftDay(today, 1);
    var people = {};
    db.allievi.forEach(function (a) { people[a.ID] = a; });
    function who(p) { var a = people[p.AllievoID] || {}; return { Nome: a.Nome || '?', Telefono: normalizePhone(a.Telefono) }; }

    var since = now.getTime() - 35 * 864e5;
    var lessons = db.lezioni.filter(function (l) { return new Date(l.Inizio).getTime() >= since; }).map(function (l) {
      var L = lessonInfo(db, l, now);
      L.Iscritti = L.Prenotazioni.filter(function (p) { return p.Stato !== 'Disdetta'; }).map(function (p) {
        var w = who(p);
        return { ID: p.ID, AllievoID: p.AllievoID, Nome: w.Nome, Telefono: w.Telefono, Stato: p.Stato, Avvisato: !!p.Avvisato, Occupa: occupies(db, p) };
      });
      delete L.Prenotazioni;
      return L;
    }).sort(function (a, b) { return new Date(a.Inizio) - new Date(b.Inizio); });
    var lessonById = {};
    lessons.forEach(function (L) { lessonById[L.ID] = L; });

    var richieste = [], promemoria = [], daAvvisare = [];
    db.prenotazioni.forEach(function (p) {
      var L = lessonById[p.LezioneID];
      if (!L || L.Ore <= 0) return;
      var base = { ID: p.ID, LezioneID: L.ID, Inizio: L.Inizio, Corso: L.Corso, Nome: who(p).Nome, Telefono: who(p).Telefono, Semaforo: L.Semaforo };
      if (L.Stato === 'Annullata') {
        if ((p.Stato === 'Richiesta' || p.Stato === 'Confermata') && !p.Avvisato) { base.Motivo = L.Motivo; daAvvisare.push(base); }
        return;
      }
      if (p.Stato === 'Richiesta') richieste.push(base);
      if (p.Stato === 'Confermata' && !p.Promemoria && cfg.dayKey(L.Inizio) === tomorrow) {
        var anticipo = (new Date(L.Inizio) - new Date(p.DataRichiesta || 0)) / 864e5;
        if (anticipo >= 3) promemoria.push(base);
      }
    });
    var sortByDate = function (a, b) { return new Date(a.Inizio) - new Date(b.Inizio); };
    richieste.sort(sortByDate); promemoria.sort(sortByDate); daAvvisare.sort(sortByDate);
    var daDecidere = lessons.filter(function (L) { return L.DaDecidere; });

    var students = db.allievi.filter(function (a) { return a.Ruolo !== 'istruttore'; }).map(function (a) {
      var packs = packages(db, a.ID, now);
      return {
        ID: a.ID, Nome: a.Nome, Email: a.Email || '', Telefono: normalizePhone(a.Telefono), Note: a.Note || '', Token: a.Token,
        Stato: statoOf(a), Preferenza: prefOf(a), NotePreferenze: a.NotePreferenze || '',
        Crediti: credits(packs), Fatte: lessonsDone(db, a.ID, now), Pacchetti: packs
      };
    }).sort(function (a, b) { return String(a.Nome).localeCompare(String(b.Nome), 'it'); });

    var s = db.impostazioni;
    return {
      lezioni: lessons, allievi: students,
      todo: { richieste: richieste, daDecidere: daDecidere, promemoria: promemoria, daAvvisare: daAvvisare },
      impostazioni: {
        NomeScuola: s.NomeScuola || '', TelefonoIstruttore: normalizePhone(s.TelefonoIstruttore), EmailIstruttore: s.EmailIstruttore || '',
        FineStagione: s.FineStagione ? cfg.dayKey(s.FineStagione) : '', AvvisoStagione: s.AvvisoStagione || '', IndirizzoApp: s.IndirizzoApp || ''
      },
      stagioneScaduta: !!s.FineStagione && cfg.dayKey(s.FineStagione) < today,
      oggi: today
    };
  }

  function myBooking(db, me, id) {
    var p = byId(db.prenotazioni, id);
    if (!p || p.AllievoID !== me.ID) fail('Prenotazione non trovata.');
    return p;
  }

  var STUDENT = {
    book: function (db, me, p, now) {
      var l = byId(db.lezioni, p.lezioneId);
      if (!l) fail('Lezione non trovata.');
      var L = lessonInfo(db, l, now);
      if (!L.Prenotabile) fail('Questa lezione non si può più prenotare dall\'app. Scrivi all\'istruttore.');
      var already = db.prenotazioni.some(function (b) { return b.LezioneID === l.ID && b.AllievoID === me.ID && occupies(db, b); });
      if (already) fail('Hai già chiesto questa lezione.');
      var pack = packages(db, me.ID, now).filter(function (k) { return k.Valido && k.Corso === l.Corso; })[0];
      if (!pack) fail('Non hai uscite disponibili per il corso ' + l.Corso + '.');
      db.prenotazioni.push({ ID: uid(), LezioneID: l.ID, AllievoID: me.ID, PacchettoID: pack.ID, Stato: 'Richiesta', DataRichiesta: now, Promemoria: false, Avvisato: false });
      touch(db, 'prenotazioni');
      return 'Richiesta inviata. L\'istruttore la confermerà.';
    },
    cancel: function (db, me, p, now) {
      var b = myBooking(db, me, p.id);
      var l = byId(db.lezioni, b.LezioneID);
      if (!occupies(db, b)) fail('Questa prenotazione non è attiva.');
      if (hoursUntil(l.Inizio, now) <= 48) fail('Mancano meno di 48 ore: avvisa direttamente l\'istruttore.');
      b.Stato = 'Disdetta';
      touch(db, 'prenotazioni');
      return 'Prenotazione disdetta. L\'uscita torna disponibile.';
    },
    setPreference: function (db, me, p) {
      if (PREFERENZE.indexOf(p.preferenza) < 0) fail('Scegli una preferenza.');
      me.Preferenza = p.preferenza;
      me.NotePreferenze = String(p.notePreferenze || '').trim().slice(0, 200);
      touch(db, 'allievi');
      return 'Preferenze salvate. Grazie!';
    }
  };

  function booking(db, id) { var b = byId(db.prenotazioni, id); if (!b) fail('Prenotazione non trovata.'); return b; }
  function lesson(db, id) { var l = byId(db.lezioni, id); if (!l) fail('Lezione non trovata.'); return l; }
  function student(db, id) { var a = byId(db.allievi, id); if (!a || a.Ruolo === 'istruttore') fail('Allievo non trovato.'); return a; }
  function parseDay(s) { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) fail('Data non valida.'); return String(s); }

  var ADMIN = {
    confirm: function (db, me, p) {
      var b = booking(db, p.id);
      if (b.Stato !== 'Richiesta') fail('Questa richiesta è già stata gestita.');
      b.Stato = 'Confermata'; touch(db, 'prenotazioni');
      return 'Prenotazione confermata.';
    },
    reject: function (db, me, p) {
      var b = booking(db, p.id);
      if (b.Stato !== 'Richiesta') fail('Questa richiesta è già stata gestita.');
      b.Stato = 'Rifiutata'; touch(db, 'prenotazioni');
      return 'Richiesta rifiutata. L\'uscita torna all\'allievo.';
    },
    setLesson: function (db, me, p) {
      var l = lesson(db, p.id);
      if (['Aperta', 'Individuale', 'Annullata'].indexOf(p.stato) < 0) fail('Stato non valido.');
      l.Stato = p.stato;
      l.Motivo = p.stato === 'Annullata' ? (p.motivo || '') : '';
      if (p.stato !== 'Annullata') db.prenotazioni.forEach(function (b) { if (b.LezioneID === l.ID) b.Avvisato = false; });
      touch(db, 'lezioni'); touch(db, 'prenotazioni');
      return { Aperta: 'Lezione riaperta.', Individuale: 'Lezione confermata come individuale.', Annullata: 'Lezione annullata. Le uscite tornano agli allievi.' }[p.stato];
    },
    extraSeat: function (db, me, p) {
      var l = lesson(db, p.id);
      var v = num(l.PostiExtra) + (p.delta > 0 ? 1 : -1);
      if (v < 0 || v > 2) fail('I posti extra vanno da 0 a 2.');
      if (v < num(l.PostiExtra) && lessonInfo(db, l, new Date()).Liberi < 1) fail('Il posto è occupato: non si può togliere.');
      l.PostiExtra = v; touch(db, 'lezioni');
      return 'Posti extra: ' + v + '.';
    },
    addLessons: function (db, me, p) {
      var day = parseDay(p.giorno);
      if (!/^\d{2}:\d{2}$/.test(String(p.ora || ''))) fail('Ora non valida.');
      if (CORSI.indexOf(p.corso) < 0) fail('Scegli il corso.');
      var weeks = Math.min(Math.max(num(p.settimane) || 1, 1), 12);
      for (var i = 0; i < weeks; i++) {
        db.lezioni.push({ ID: uid(), Inizio: cfg.makeDate(shiftDay(day, 7 * i), p.ora), DurataOre: num(p.durata) || 3, Corso: p.corso,
          Posti: num(p.posti) || 2, PostiExtra: 0, Stato: 'Aperta', Motivo: '', Note: p.note || '' });
      }
      touch(db, 'lezioni');
      return weeks === 1 ? 'Lezione aggiunta.' : weeks + ' lezioni aggiunte.';
    },
    deleteLesson: function (db, me, p) {
      lesson(db, p.id);
      if (db.prenotazioni.some(function (b) { return b.LezioneID === p.id; })) fail('Ci sono prenotazioni: annulla la lezione invece di eliminarla.');
      db.lezioni = db.lezioni.filter(function (l) { return l.ID !== p.id; });
      touch(db, 'lezioni');
      return 'Lezione eliminata.';
    },
    reminderSent: function (db, me, p) { booking(db, p.id).Promemoria = true; touch(db, 'prenotazioni'); return ''; },
    notified: function (db, me, p) { booking(db, p.id).Avvisato = true; touch(db, 'prenotazioni'); return ''; },
    addStudent: function (db, me, p) {
      var nome = String(p.nome || '').trim();
      if (!nome) fail('Scrivi il nome.');
      var tel = normalizePhone(p.telefono);
      if (tel && tel.length < 11) fail('Il telefono deve avere il prefisso 39 e il numero completo.');
      var a = { ID: uid(), Nome: nome, Email: String(p.email || '').trim(), Telefono: tel, Ruolo: 'allievo', Token: newToken(), Note: p.note || '',
        Stato: 'Attivo', Preferenza: PREFERENZE.indexOf(p.preferenza) >= 0 ? p.preferenza : 'Indifferente', NotePreferenze: p.notePreferenze || '' };
      db.allievi.push(a); touch(db, 'allievi');
      return { msg: 'Allievo aggiunto.', id: a.ID };
    },
    updateStudent: function (db, me, p) {
      var a = student(db, p.id);
      if (!String(p.nome || '').trim()) fail('Scrivi il nome.');
      a.Nome = String(p.nome).trim(); a.Email = String(p.email || '').trim(); a.Telefono = normalizePhone(p.telefono); a.Note = p.note || '';
      if (PREFERENZE.indexOf(p.preferenza) >= 0) a.Preferenza = p.preferenza;
      if (p.notePreferenze !== undefined) a.NotePreferenze = p.notePreferenze;
      touch(db, 'allievi');
      return 'Dati salvati.';
    },
    setStatus: function (db, me, p) {
      var a = student(db, p.id);
      if (STATI.indexOf(p.stato) < 0) fail('Stato non valido.');
      a.Stato = p.stato; touch(db, 'allievi');
      return { 'Attivo': 'Allievo attivo.', 'Non attivo': 'Allievo non attivo: non riceverà comunicazioni.', 'Interessato': 'Allievo interessato: resta nei contatti per eventi e newsletter.', 'Spento': 'Allievo spento: niente comunicazioni e accesso all\'app disattivato.' }[p.stato];
    },
    newLink: function (db, me, p) { student(db, p.id).Token = newToken(); touch(db, 'allievi'); return 'Nuovo link creato. Il vecchio non funziona più.'; },
    addPackage: function (db, me, p, now) {
      student(db, p.allievoId);
      if (CORSI_PACCHETTO.indexOf(p.corso) < 0) fail('Scegli il corso.');
      var scad = p.scadenza ? cfg.makeDate(parseDay(p.scadenza), '00:00') : db.impostazioni.FineStagione;
      db.pacchetti.push({ ID: uid(), AllievoID: p.allievoId, Corso: p.corso, Uscite: num(p.uscite) || 4, DataAcquisto: now, Scadenza: scad || '', Note: p.note || '' });
      touch(db, 'pacchetti');
      return 'Pacchetto ' + p.corso + ' aggiunto.';
    },
    updatePackage: function (db, me, p) {
      var k = byId(db.pacchetti, p.id);
      if (!k) fail('Pacchetto non trovato.');
      if (p.scadenza) k.Scadenza = cfg.makeDate(parseDay(p.scadenza), '00:00');
      if (p.uscite !== undefined && p.uscite !== '') k.Uscite = Math.max(num(p.uscite), 1);
      touch(db, 'pacchetti');
      return 'Pacchetto aggiornato.';
    },
    deletePackage: function (db, me, p) {
      if (db.prenotazioni.some(function (b) { return b.PacchettoID === p.id; })) fail('Il pacchetto è già stato usato: modifica le uscite invece di eliminarlo.');
      db.pacchetti = db.pacchetti.filter(function (k) { return k.ID !== p.id; });
      touch(db, 'pacchetti');
      return 'Pacchetto eliminato.';
    },
    saveSettings: function (db, me, p) {
      var s = db.impostazioni;
      ['NomeScuola', 'EmailIstruttore', 'AvvisoStagione', 'IndirizzoApp'].forEach(function (k) { if (p[k] !== undefined) s[k] = String(p[k]).trim(); });
      if (p.TelefonoIstruttore !== undefined) s.TelefonoIstruttore = normalizePhone(p.TelefonoIstruttore);
      if (p.FineStagione) s.FineStagione = cfg.makeDate(parseDay(p.FineStagione), '00:00');
      touch(db, 'impostazioni');
      return 'Impostazioni salvate.';
    }
  };

  function handle(db, token, action, payload, now) {
    var me = null;
    for (var i = 0; i < db.allievi.length; i++) if (token && db.allievi[i].Token === token) me = db.allievi[i];
    if (!me) fail('Link non valido. Chiedi all\'istruttore il tuo link personale.');
    var admin = me.Ruolo === 'istruttore';
    if (!admin && statoOf(me) === 'Spento') fail('Il tuo accesso non è più attivo. Per tornare in barca contatta l\'istruttore.');
    var out = '', extra = {};
    if (action && action !== 'view') {
      var fn = admin ? ADMIN[action] : STUDENT[action];
      if (!fn) fail('Operazione non permessa.');
      var r = fn(db, me, payload || {}, now);
      if (r && typeof r === 'object') { out = r.msg; extra = r; } else out = r || '';
    }
    return { ok: true, role: admin ? 'istruttore' : 'allievo', nome: me.Nome, msg: out, id: extra.id || '', view: admin ? adminView(db, now) : studentView(db, me, now) };
  }

  return { STATI: STATI, PREFERENZE: PREFERENZE, configure: configure, handle: handle, adminView: adminView, normalizePhone: normalizePhone, newToken: newToken, uid: uid, shiftDay: shiftDay };
})();
