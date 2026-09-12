CREATE TABLE IF NOT EXISTS usuarios (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    nombre TEXT NOT NULL,
    rol TEXT CHECK(rol IN ('admin', 'medico', 'recepcion')) NOT NULL DEFAULT 'admin',
    activo INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO usuarios (id, email, nombre, rol) VALUES
('usr_1', 'payoyus@gmail.com', 'Pablo Olguín', 'admin'),
('usr_2', 'pablo_fzr@live.com', 'Pablo', 'admin'),
('usr_3', 'agostinatropea19@gmail.com', 'Agostina Tropea', 'admin'),
('usr_4', 'leandroeguia@gmail.com', 'Leandro Eguia', 'admin');