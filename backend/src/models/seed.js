import bcrypt from 'bcryptjs';
import { transaction } from '../config/database.js';
import { now, stamp, parse, dayKey, addDays, randomToken } from '../config/time.js';
import { defaultSchedule, slots, createBooking } from './booking.js';

const weekday = (value) => (parse(`${dayKey(value)}T12:00`).getUTCDay() + 6) % 7;
const minutesAfter = (value, minutes) => new Date(value.getTime() + minutes * 60_000);

function seedMarina(db, clock) {
  const pid = Number(
    db
      .prepare(
        'INSERT INTO professionals(name,email,password,phone,slug,business,bio,schedule,category,city) VALUES(?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        'Marina Almeida',
        'demo@agendafacil.com',
        bcrypt.hashSync('Agenda@123', 12),
        '11987654321',
        'studio-marina',
        'Studio Marina',
        'Um tempo para você. Cuidados de beleza e bem-estar com atenção a cada detalhe. Vila Madalena, São Paulo.',
        JSON.stringify(defaultSchedule()),
        'Beleza e cuidados',
        'São Paulo',
      ).lastInsertRowid,
  );
  const offerings = [
    [
      'Design de sobrancelhas',
      'Design personalizado para valorizar sua expressão.',
      30,
      4500,
      'sage',
    ],
    ['Manicure completa', 'Cuidado, esmaltação e acabamento delicado.', 60, 6500, 'peach'],
    ['Limpeza de pele', 'Um ritual de renovação e cuidado para sua pele.', 90, 15000, 'lavender'],
    [
      'Massagem relaxante',
      'Uma pausa para aliviar tensões e recuperar o equilíbrio.',
      60,
      12000,
      'blue',
    ],
  ];
  const ids = offerings.map((s) =>
    Number(
      db
        .prepare(
          'INSERT INTO services(professional_id,name,description,duration,price,color) VALUES(?,?,?,?,?,?)',
        )
        .run(pid, ...s).lastInsertRowid,
    ),
  );
  const names = [
    'Ana Carolina',
    'Beatriz Santos',
    'Camila Oliveira',
    'Daniela Costa',
    'Fernanda Lima',
    'Isabela Rocha',
    'Juliana Martins',
    'Luiza Ferreira',
  ];
  const clients = names.map((name, i) =>
    Number(
      db
        .prepare(
          'INSERT INTO clients(professional_id,name,email,phone,history_token) VALUES(?,?,?,?,?)',
        )
        .run(pid, name, `cliente${i + 1}@example.com`, `1198888000${i}`, randomToken())
        .lastInsertRowid,
    ),
  );
  const currentTime = now(clock);
  const today = dayKey(currentTime);
  for (let offset = -28; offset < 8; offset++) {
    const key = addDays(today, offset);
    const day = parse(`${key}T00:00`);
    if (weekday(day) === 6) continue;
    const hours = weekday(day) < 5 ? [9, 10, 14, 16] : [9, 10, 11];
    for (const [j, hour] of hours.entries()) {
      let k = (Math.abs(offset) + j) % 4;
      // A 90-minute treatment occupies the day's last seeded slot.
      if (k === 2 && j < hours.length - 1) k = 0;
      const start = parse(`${key}T${String(hour).padStart(2, '0')}:00`);
      const end = minutesAfter(start, offerings[k][2]);
      if (weekday(day) === 5 && Number(stamp(end).slice(11, 13)) >= 14) continue;
      let status = end < currentTime ? 'completed' : j === 1 ? 'pending' : 'confirmed';
      if (offset < 0 && (Math.abs(offset) + j) % 11 === 0) status = 'cancelled';
      if (offset < 0 && (Math.abs(offset) + j) % 17 === 0) status = 'absent';
      const snapshot = [
        {
          id: ids[k],
          name: offerings[k][0],
          duration: offerings[k][2],
          price: offerings[k][3] / 100,
          color: offerings[k][4],
        },
      ];
      db.prepare(
        'INSERT INTO appointments(professional_id,client_id,start,end,services,total,status,token,notes,created) VALUES(?,?,?,?,?,?,?,?,?,?)',
      ).run(
        pid,
        clients[(Math.abs(offset) + j) % 8],
        stamp(start),
        stamp(end),
        JSON.stringify(snapshot),
        offerings[k][3],
        status,
        randomToken(),
        'Dados fictícios de demonstração.',
        stamp(parse(`${addDays(key, -3)}T00:00`)),
      );
    }
  }
}

function seedDiscovery(db) {
  // Enrich metadata only; preserve profiles, offerings, passwords and bookings.
  db.prepare(
    "UPDATE professionals SET city='São Paulo' WHERE email='demo@agendafacil.com' AND city=''",
  ).run();
  const profiles = [
    [
      'Lia Martins',
      'aurora@agendafacil.com',
      '11987650001',
      'casa-aurora',
      'Casa Aurora',
      'Massagem e bem-estar',
      'São Paulo',
      'Um refúgio tranquilo em Pinheiros. Massagens e rituais para desacelerar, respirar e voltar para si.',
      0,
      [
        [
          'Massagem relaxante',
          'Óleos suaves, movimentos lentos e uma pausa só sua.',
          60,
          14000,
          'sage',
        ],
        ['Drenagem linfática', 'Cuidado delicado para leveza e bem-estar.', 60, 16000, 'peach'],
        [
          'Ritual de pedras quentes',
          'Calor acolhedor para aliviar as tensões do dia.',
          90,
          21000,
          'lavender',
        ],
      ],
    ],
    [
      'Caio Moreira',
      'caio@agendafacil.com',
      '11987650002',
      'caio-barbearia',
      'Caio Corte & Barba',
      'Barbearia',
      'São Paulo',
      'Cortes precisos e uma boa conversa na Santa Cecília. Do clássico ao seu próximo estilo.',
      1,
      [
        ['Corte masculino', 'Consulta de estilo, corte e finalização.', 45, 7500, 'blue'],
        ['Barba com toalha quente', 'Desenho, cuidado e acabamento da barba.', 30, 5000, 'peach'],
        ['Corte + barba', 'Seu ritual completo, com tempo e atenção.', 75, 11500, 'sage'],
      ],
    ],
    [
      'Clara Nunes',
      'clara@agendafacil.com',
      '11987650003',
      'clara-atelie',
      'Clara Ateliê',
      'Unhas',
      'Santo André',
      'Cor, desenho e delicadeza em cada detalhe. Um pequeno ateliê no Jardim, com horário reservado para você.',
      1,
      [
        ['Manicure natural', 'Cuidado das unhas, cutículas e esmaltação.', 45, 5000, 'peach'],
        [
          'Esmaltação em gel',
          'Brilho e acabamento para acompanhar sua rotina.',
          75,
          9500,
          'lavender',
        ],
        ['Nail art', 'Detalhes e desenhos escolhidos junto com você.', 90, 14000, 'blue'],
      ],
    ],
    [
      'Rafael Costa',
      'movimento@agendafacil.com',
      '19987650004',
      'movimento-fisio',
      'Movimento Fisio',
      'Fisioterapia',
      'Campinas',
      'Atendimento individual no Cambuí, com escuta e movimento. Cada sessão acompanha o seu ritmo.',
      1,
      [
        [
          'Avaliação fisioterapêutica',
          'Primeira conversa e avaliação individual.',
          60,
          18000,
          'sage',
        ],
        [
          'Sessão de fisioterapia',
          'Atendimento individual com plano de cuidado.',
          60,
          16000,
          'blue',
        ],
        ['Pilates individual', 'Movimento orientado para sua rotina.', 60, 12000, 'lavender'],
      ],
    ],
    [
      'Bianca Reis',
      'iris@agendafacil.com',
      '11987650005',
      'espaco-iris',
      'Espaço Íris',
      'Estética',
      'São Paulo',
      'Cuidado da pele sem pressa em Moema. Protocolos individuais e uma experiência acolhedora do começo ao fim.',
      1,
      [
        ['Limpeza de pele', 'Higienização, cuidado e hidratação facial.', 90, 17000, 'lavender'],
        ['Hidratação facial', 'Uma pausa de cuidado para a sua pele.', 45, 9500, 'peach'],
        ['Design de sobrancelhas', 'Desenho personalizado e acabamento natural.', 30, 5500, 'sage'],
      ],
    ],
  ];
  for (const [
    name,
    email,
    phone,
    slug,
    business,
    category,
    city,
    bio,
    approve,
    offerings,
  ] of profiles) {
    // A matching email or slug may belong to an edited or user-owned profile.
    if (db.prepare('SELECT 1 FROM professionals WHERE email=? OR slug=?').get(email, slug))
      continue;
    const pid = Number(
      db
        .prepare(
          'INSERT INTO professionals(name,email,password,phone,slug,business,bio,schedule,category,city,auto_approve) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          name,
          email,
          bcrypt.hashSync('Agenda@123', 12),
          phone,
          slug,
          business,
          bio,
          JSON.stringify(defaultSchedule()),
          category,
          city,
          approve,
        ).lastInsertRowid,
    );
    for (const offering of offerings) {
      db.prepare(
        'INSERT INTO services(professional_id,name,description,duration,price,color) VALUES(?,?,?,?,?,?)',
      ).run(pid, ...offering);
    }
  }
}

function seedClient(db, clock) {
  let account = db
    .prepare('SELECT * FROM client_accounts WHERE email=?')
    .get('cliente@agendafacil.com');
  if (!account) {
    db.prepare('INSERT INTO client_accounts(name,email,phone,password) VALUES(?,?,?,?)').run(
      'Júlia Oliveira',
      'cliente@agendafacil.com',
      '11999556677',
      bcrypt.hashSync('Cliente@123', 12),
    );
    account = db
      .prepare('SELECT * FROM client_accounts WHERE email=?')
      .get('cliente@agendafacil.com');
  }
  for (const [slug, email] of [
    ['studio-marina', 'demo@agendafacil.com'],
    ['casa-aurora', 'aurora@agendafacil.com'],
  ]) {
    const p = db.prepare('SELECT * FROM professionals WHERE slug=? AND email=?').get(slug, email);
    const marker = `Demonstração da conta cliente: ${slug}.`;
    if (
      !p ||
      db
        .prepare('SELECT 1 FROM appointments WHERE account_id=? AND notes=?')
        .get(account.id, marker)
    )
      continue;
    const s = db
      .prepare('SELECT * FROM services WHERE professional_id=? AND active=1 ORDER BY id LIMIT 1')
      .get(p.id);
    if (!s) continue;
    for (let offset = 2; offset < 15; offset++) {
      const day = addDays(dayKey(now(clock)), offset);
      const available = slots(db, p, day, [s.id], clock);
      if (!available.length) continue;
      createBooking(
        db,
        p,
        {
          name: account.name,
          email: account.email,
          phone: account.phone,
          service_ids: [s.id],
          start: available[0],
          notes: marker,
        },
        { clock, accountId: account.id },
      );
      break;
    }
  }
  const p = db
    .prepare('SELECT * FROM professionals WHERE slug=? AND email=?')
    .get('caio-barbearia', 'caio@agendafacil.com');
  const marker = 'Demonstração da conta cliente: atendimento anterior.';
  if (
    p &&
    !db.prepare('SELECT 1 FROM appointments WHERE account_id=? AND notes=?').get(account.id, marker)
  ) {
    const s = db
      .prepare('SELECT * FROM services WHERE professional_id=? AND active=1 ORDER BY id LIMIT 1')
      .get(p.id);
    if (!s) return;
    const client = db
      .prepare('SELECT id FROM clients WHERE professional_id=? AND email=?')
      .get(p.id, account.email);
    const cid = client
      ? client.id
      : Number(
          db
            .prepare(
              'INSERT INTO clients(professional_id,name,email,phone,history_token) VALUES(?,?,?,?,?)',
            )
            .run(p.id, account.name, account.email, account.phone, randomToken()).lastInsertRowid,
        );
    const day = parse(`${addDays(dayKey(now(clock)), -5)}T10:00`);
    const snapshot = [
      { id: s.id, name: s.name, duration: s.duration, price: s.price / 100, color: s.color },
    ];
    db.prepare(
      'INSERT INTO appointments(professional_id,client_id,start,end,services,total,status,token,notes,created,account_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      p.id,
      cid,
      stamp(day),
      stamp(minutesAfter(day, s.duration)),
      JSON.stringify(snapshot),
      s.price,
      'completed',
      randomToken(),
      marker,
      stamp(parse(`${addDays(dayKey(day), -2)}T10:00`)),
      account.id,
    );
  }
}

export function seed(db, { clock } = {}) {
  transaction(db, () => {
    if (
      !db
        .prepare('SELECT id FROM professionals WHERE email=? OR slug=?')
        .get('demo@agendafacil.com', 'studio-marina')
    )
      seedMarina(db, clock);
    seedDiscovery(db);
    seedClient(db, clock);
  });
  return 'Demo profissional: demo@agendafacil.com / Agenda@123 • Cliente: cliente@agendafacil.com / Cliente@123';
}
