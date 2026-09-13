let pacienteActivoId = null;
let usuarioConectado = null;

const modalPaciente = new bootstrap.Modal(document.getElementById('modalNuevoPaciente'));
const modalSesion = new bootstrap.Modal(document.getElementById('modalNuevaSesion'));
const modalDocumentos = new bootstrap.Modal(document.getElementById('modalDocumentacion'));

function escapeHtml(unsafe) {
  if (!unsafe) return '';
  return String(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

window.onload = async function () {
  await inicializarUsuario();
  await cargarPacientes();
};

async function inicializarUsuario() {
  try {
    const res = await fetch('/api/me');
    if (res.ok) {
      usuarioConectado = await res.json();
      document.getElementById('userPill').innerHTML = '<i class="bi bi-person-circle me-1 text-gold"></i> ' + escapeHtml(usuarioConectado.nombre) + ' (' + escapeHtml(usuarioConectado.rol.toUpperCase()) + ')';
      const inputProf = document.getElementById('sProfesional');
      if (inputProf) inputProf.value = usuarioConectado.nombre;
    }
  } catch (err) {
    console.error('Error al obtener usuario conectado:', err);
  }
}

let timeoutBuscador = null;
function filtrarPacientes() {
  clearTimeout(timeoutBuscador);
  timeoutBuscador = setTimeout(function () {
    cargarPacientes(document.getElementById('buscador').value);
  }, 250);
}

async function cargarPacientes(query = '') {
  const res = await fetch('/api/pacientes?q=' + encodeURIComponent(query), { cache: 'no-store' });
  const pacientes = await res.json();
  const lista = document.getElementById('listaPacientes');
  lista.innerHTML = '';

  if (!pacientes.length) {
    lista.innerHTML = '<div class="p-3 text-center text-muted small">No se encontraron pacientes.</div>';
    return;
  }

  pacientes.forEach(function (p) {
    const item = document.createElement('a');
    item.className = 'list-group-item list-group-item-action paciente-item py-2 px-3 border-start-0 border-end-0 ' + (p.id === pacienteActivoId ? 'active' : '');
    item.innerHTML = '<div class="fw-bold">' + escapeHtml(p.nombre_completo) + '</div><div class="small text-muted">DNI: ' + escapeHtml(p.dni) + ' | ' + escapeHtml(p.telefono || 'Sin tel') + '</div>';
    item.onclick = function () { seleccionarPaciente(p.id); };
    lista.appendChild(item);
  });
}

async function seleccionarPaciente(id) {
  pacienteActivoId = id;
  document.getElementById('placeholderVacio').style.display = 'none';
  document.getElementById('detallePaciente').style.display = 'block';

  document.querySelectorAll('.paciente-item').forEach(function (el) { el.classList.remove('active'); });

  const res = await fetch('/api/pacientes/' + id + '/historial?t=' + Date.now(), { cache: 'no-store' });
  const data = await res.json();
  const p = data.paciente;

  document.getElementById('pacienteNombre').innerText = p.nombre_completo;
  document.getElementById('pacienteInfo').innerText = 'DNI: ' + p.dni + ' | Tel: ' + (p.telefono || 'N/A') + ' | Email: ' + (p.email || 'N/A');

  const divAlergias = document.getElementById('alertasAlergia');
  if (p.antecedentes_alergias) {
    divAlergias.innerHTML = '<i class="bi bi-exclamation-circle-fill me-2 text-gold"></i><strong>Antecedentes / Alergias:</strong> ' + escapeHtml(p.antecedentes_alergias);
    divAlergias.style.display = 'block';
  } else {
    divAlergias.style.display = 'none';
  }

  const docsDiv = document.getElementById('docsContainer');
  let docsHtml = '';
  if (p.url_consentimiento) {
    docsHtml += '<a href="' + encodeURI(p.url_consentimiento) + '" target="_blank" class="btn btn-outline-secondary btn-sm doc-badge"><i class="bi bi-file-earmark-medical me-1"></i> Consentimiento Médico</a>';
  }
  if (p.url_historia_clinica) {
    docsHtml += '<a href="' + encodeURI(p.url_historia_clinica) + '" target="_blank" class="btn btn-outline-secondary btn-sm doc-badge"><i class="bi bi-file-earmark-text me-1"></i> Historia Clínica</a>';
  }
  if (!p.url_consentimiento && !p.url_historia_clinica) {
    docsHtml = '<span class="text-muted small">Sin documentación adjunta.</span>';
  }
  docsDiv.innerHTML = docsHtml;

  const contSesiones = document.getElementById('historialSesiones');
  if (!data.historial || !data.historial.length) {
    contSesiones.innerHTML = '<p class="text-muted small">No hay sesiones registradas para este paciente.</p>';
    return;
  }

  let htmlSesiones = '';
  data.historial.forEach(function (s) {
    // Normalización para interpretar correctamente la fecha UTC guardada por SQLite (D1)
    let rawFecha = s.fecha_tratamiento || '';
    if (rawFecha && !rawFecha.endsWith('Z') && !rawFecha.includes('+')) {
      rawFecha = rawFecha.replace(' ', 'T') + 'Z';
    }
    const fecha = new Date(rawFecha);
    const fechaStr = isNaN(fecha.getTime()) 
      ? s.fecha_tratamiento 
      : (fecha.toLocaleDateString() + ' ' + fecha.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));

    let profesionalBadge = '';
    const textoProfesional = s.profesional_nombre || s.profesional_id;
    if (textoProfesional && textoProfesional !== 'profesional_general') {
      profesionalBadge = '<span class="badge bg-white text-secondary border"><i class="bi bi-person me-1"></i>' + escapeHtml(textoProfesional) + '</span>';
    }

    // Clasificación de fotos según su etiqueta
    const fotosAntes = (s.fotos || []).filter(function(f) { return f.etiqueta === 'antes'; });
    const fotosDespues = (s.fotos || []).filter(function(f) { return f.etiqueta !== 'antes'; });

    let cuerpoFotosHtml = '';

    if (!s.fotos || s.fotos.length === 0) {
      cuerpoFotosHtml = '<p class="text-muted small ps-2 mb-0">Sin fotografías en esta sesión.</p>';
    } else if (fotosAntes.length > 0 && fotosDespues.length > 0) {
      // Caso 1: Comparación lado a lado (Antes vs Después)
      cuerpoFotosHtml = 
        '<div class="row g-3 mt-1">' +
          '<div class="col-md-6 border-end pe-md-3">' +
            '<h6 class="fw-bold small text-uppercase text-muted mb-2" style="letter-spacing: 0.05em;"><i class="bi bi-arrow-left-circle me-1"></i> Antes</h6>' +
            '<div class="row g-2">' + renderGaleriaFotos(fotosAntes) + '</div>' +
          '</div>' +
          '<div class="col-md-6 ps-md-3">' +
            '<h6 class="fw-bold small text-uppercase text-dark mb-2" style="letter-spacing: 0.05em;"><i class="bi bi-check2-circle text-gold me-1"></i> Resultado / Después</h6>' +
            '<div class="row g-2">' + renderGaleriaFotos(fotosDespues) + '</div>' +
          '</div>' +
        '</div>';
    } else {
      // Caso 2: Solo un bloque
      const esAntes = fotosAntes.length > 0;
      const titulo = esAntes 
        ? '<i class="bi bi-arrow-left-circle me-1"></i> Registro Inicial' 
        : '<i class="bi bi-shield-check me-1 text-gold"></i> Seguimiento / Evolución';
      const colorClase = esAntes ? 'text-muted' : 'text-dark';
      const listaFotos = esAntes ? fotosAntes : fotosDespues;

      cuerpoFotosHtml = 
        '<div class="mt-1">' +
          '<h6 class="' + colorClase + ' fw-bold small text-uppercase mb-2" style="letter-spacing: 0.05em;">' + titulo + '</h6>' +
          '<div class="row g-2">' + renderGaleriaFotos(listaFotos) + '</div>' +
        '</div>';
    }

    htmlSesiones += 
      '<div class="border rounded p-3 bg-white mb-3 shadow-sm">' +
        '<div class="d-flex flex-wrap justify-content-between align-items-center mb-1 gap-1">' +
          '<div class="d-flex align-items-center gap-2">' +
            '<span class="badge bg-secondary">' + escapeHtml(s.tipo_tratamiento) + '</span>' +
            profesionalBadge +
          '</div>' +
          '<small class="text-muted">' + escapeHtml(fechaStr) + '</small>' +
        '</div>' +
        '<p class="small text-secondary mb-2">' + escapeHtml(s.descripcion || '') + '</p>' +
        cuerpoFotosHtml +
      '</div>';
  });

  contSesiones.innerHTML = htmlSesiones;
}

async function guardarPaciente(e) {
  e.preventDefault();
  const btn = document.getElementById('btnGuardarPaciente');
  btn.disabled = true;
  btn.innerText = 'Guardando...';

  const payload = {
    nombre_completo: document.getElementById('pNombre').value,
    dni: document.getElementById('pDni').value,
    telefono: document.getElementById('pTel').value,
    email: document.getElementById('pEmail').value,
    fecha_nacimiento: document.getElementById('pNac').value,
    antecedentes_alergias: document.getElementById('pAlergias').value
  };

  try {
    const res = await fetch('/api/pacientes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || data.detalle || 'Error al guardar');

    modalPaciente.hide();
    document.getElementById('formPaciente').reset();
    await cargarPacientes();
    await seleccionarPaciente(data.id);
  } catch (err) {
    alert('Error: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.innerText = 'Guardar Paciente';
  }
}

async function guardarDocumentacion(e) {
  e.preventDefault();
  if (!pacienteActivoId) {
    alert('Selecciona primero un paciente.');
    return;
  }

  const fileConsentimiento = document.getElementById('docConsentimiento').files[0];
  const fileHistoria = document.getElementById('docHistoria').files[0];

  if (!fileConsentimiento && !fileHistoria) {
    alert('Por favor selecciona al menos un archivo.');
    return;
  }

  const btn = document.getElementById('btnGuardarDocs');
  btn.disabled = true;
  btn.innerText = 'Subiendo en paralelo...';

  try {
    const promesas = [];

    if (fileConsentimiento) {
      const fd = new FormData();
      fd.append('archivo', fileConsentimiento);
      promesas.push(
        fetch('/api/pacientes/' + pacienteActivoId + '/documentos/consentimiento', { method: 'POST', body: fd })
          .then(async function (r) { if (!r.ok) throw new Error('Error al subir Consentimiento'); })
      );
    }

    if (fileHistoria) {
      const fd = new FormData();
      fd.append('archivo', fileHistoria);
      promesas.push(
        fetch('/api/pacientes/' + pacienteActivoId + '/documentos/historia', { method: 'POST', body: fd })
          .then(async function (r) { if (!r.ok) throw new Error('Error al subir Historia Clínica'); })
      );
    }

    await Promise.all(promesas);

    modalDocumentos.hide();
    document.getElementById('formDocumentacion').reset();
    await seleccionarPaciente(pacienteActivoId);
  } catch (err) {
    alert('Error: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.innerText = 'Subir Documentos';
  }
}

async function optimizarImagen(archivo) {
  if (!archivo.type.startsWith('image/')) return archivo;

  return new Promise(function (resolve) {
    const reader = new FileReader();
    reader.readAsDataURL(archivo);
    reader.onload = function (event) {
      const img = new Image();
      img.src = event.target.result;
      img.onload = function () {
        const canvas = document.createElement('canvas');
        const MAX = 1400;
        let width = img.width;
        let height = img.height;

        if (width > height && width > MAX) {
          height *= MAX / width;
          width = MAX;
        } else if (height > MAX) {
          width *= MAX / height;
          height = MAX;
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        canvas.toBlob(function (blob) {
          if (!blob) return resolve(archivo);
          const archivoComprimido = new File([blob], archivo.name.replace(/\.[^/.]+$/, ".jpg"), {
            type: 'image/jpeg',
            lastModified: Date.now()
          });
          resolve(archivoComprimido);
        }, 'image/jpeg', 0.80);
      };
      img.onerror = function () { resolve(archivo); };
    };
    reader.onerror = function () { resolve(archivo); };
  });
}

async function guardarSesion(e) {
  e.preventDefault();
  const btn = document.getElementById('btnGuardarSesion');
  btn.disabled = true;
  btn.innerText = 'Creando sesión...';

  if (!pacienteActivoId) {
    alert('Error: No hay paciente seleccionado.');
    btn.disabled = false;
    btn.innerText = 'Guardar Sesión';
    return;
  }

  const profesional = document.getElementById('sProfesional').value;
  const tipo = document.getElementById('sTipo').value;
  const desc = document.getElementById('sDesc').value;

  try {
    const res = await fetch('/api/sesiones', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paciente_id: pacienteActivoId,
        profesional: profesional,
        tipo_tratamiento: tipo,
        descripcion: desc
      })
    });

    const data = await res.json();
    if (!res.ok || !data.id) {
      throw new Error(data.error || data.detalle || 'Error al crear sesión.');
    }

    const nuevaSesionId = data.id;
    const inputAntes = document.getElementById('sFotosAntes');
    const inputDespues = document.getElementById('sFotosDespues');

    const listaSubidas = [];

    if (inputAntes && inputAntes.files.length > 0) {
      Array.from(inputAntes.files).forEach((file) => {
        listaSubidas.push({ file, etiqueta: 'antes' });
      });
    }

    if (inputDespues && inputDespues.files.length > 0) {
      Array.from(inputDespues.files).forEach((file) => {
        listaSubidas.push({ file, etiqueta: 'despues' });
      });
    }

    if (listaSubidas.length > 0) {
      btn.innerText = `Optimizando ${listaSubidas.length} fotos...`;
      const optimizadas = await Promise.all(
        listaSubidas.map(async (item) => ({
          archivo: await optimizarImagen(item.file),
          etiqueta: item.etiqueta
        }))
      );

      btn.innerText = `Subiendo ${optimizadas.length} fotos en paralelo...`;
      await Promise.all(optimizadas.map(async (item) => {
        const formData = new FormData();
        formData.append('foto', item.archivo);
        formData.append('etiqueta', item.etiqueta);

        const uploadRes = await fetch('/api/sesiones/' + nuevaSesionId + '/fotos', {
          method: 'POST',
          body: formData
        });

        if (!uploadRes.ok) {
          const errUpload = await uploadRes.json();
          throw new Error(errUpload.error || 'Fallo al subir una de las imágenes');
        }
      }));
    }

    modalSesion.hide();
    document.getElementById('formSesion').reset();
    if (usuarioConectado) {
      document.getElementById('sProfesional').value = usuarioConectado.nombre;
    }
    await seleccionarPaciente(pacienteActivoId);
  } catch (err) {
    alert('Fallo: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.innerText = 'Guardar Sesión';
  }
}

function renderGaleriaFotos(fotos) {
  return fotos.map(function (f) {
    return '<div class="col-6 col-sm-4">' +
      '<div class="photo-card mb-1">' +
        '<span class="photo-tag badge-' + escapeHtml(f.etiqueta) + '">' + escapeHtml(f.etiqueta.toUpperCase()) + '</span>' +
        '<a href="' + encodeURI(f.url_visualizacion) + '" target="_blank">' +
          '<img src="' + encodeURI(f.url_visualizacion) + '" alt="Foto clínica" loading="lazy">' +
        '</a>' +
      '</div>' +
    '</div>';
  }).join('');
}