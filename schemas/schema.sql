-- Tabla de profesionales (usuarios del sistema)
CREATE TABLE IF NOT EXISTS profesionales (
    id TEXT PRIMARY KEY,
    nombre_completo TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    especialidad TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Tabla de pacientes
CREATE TABLE IF NOT EXISTS pacientes (
    id TEXT PRIMARY KEY,
    dni TEXT UNIQUE NOT NULL,
    nombre_completo TEXT NOT NULL,
    telefono TEXT,
    email TEXT,
    fecha_nacimiento DATE,
    antecedentes_alergias TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pacientes_dni ON pacientes(dni);
CREATE INDEX IF NOT EXISTS idx_pacientes_nombre ON pacientes(nombre_completo);

-- Tabla de sesiones o tratamientos realizados
CREATE TABLE IF NOT EXISTS sesiones_tratamiento (
    id TEXT PRIMARY KEY,
    paciente_id TEXT NOT NULL,
    profesional_id TEXT NOT NULL,
    fecha_tratamiento DATETIME DEFAULT CURRENT_TIMESTAMP,
    tipo_tratamiento TEXT NOT NULL,
    descripcion TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (paciente_id) REFERENCES pacientes(id) ON DELETE CASCADE,
    FOREIGN KEY (profesional_id) REFERENCES profesionales(id)
);

CREATE INDEX IF NOT EXISTS idx_sesiones_paciente ON sesiones_tratamiento(paciente_id);

-- Tabla de fotos vinculadas a cada tratamiento
CREATE TABLE IF NOT EXISTS fotos_tratamiento (
    id TEXT PRIMARY KEY,
    sesion_id TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    etiqueta TEXT CHECK(etiqueta IN ('antes', 'despues', 'control', 'otro')) DEFAULT 'otro',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (sesion_id) REFERENCES sesiones_tratamiento(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_fotos_sesion ON fotos_tratamiento(sesion_id);