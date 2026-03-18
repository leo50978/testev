/* 
    Domino ThreeJS creado por Josep Antoni Bover Comas el 16/01/2019

        MAIN para el javascript

        Vista por defecto en el Laboratorio de pruebas  
		devildrey33_Lab->Opciones->Vista = Filas;

        Ultima modificaciÃ³n el 28/02/2019
*/

/* 
    TODO :
        V Renovat el ObjetoCanvas, ara s'ha de crear abans del event load, i ell mateix ja es carrega en el load.
        V Reajustat el menu inicial, i ara he separat les opcions i els noms dels equips en finestres diferents (mes que res per resolucions petites...)
        V Traduit al català i a l'angles.
            - Falta fer uns butons a les opcions
        
        - Puc posar ficha al acabar la mà ¡ no estic segur si es nomes en el meu torn o sempre... xd) no influeix en la puntuació del equip (per que es calcula abans) pero es un bug curiÃ³s
        - Ara veig que he DES-ajustat la llum, i al mostrar 2 posibilitats en una fitxa es segueix veient la ficha practivament blanca... (hauria de ser groga)
            - Deu tenir que veure amb l'ajustament que li he fet per portrait / landscape / desktop

        - Nivell de dificultat (facil rand / normal)
            - Afegir predilecciÃ³ per tirar una doble si es posible abans de tirar la que major puntuaciÃ³ tingui?
                - Jo crec que es 99% factible a no ser que em pensi una IA que pugui tancar partides si ho veu posible i necesari.... (maÃ§a curru igual per una 2.0)
        V Les finestres de victoria i derrota no posen els noms dels equips i dels jugadors guardats en el localstorage...
        - Idiomes (CatalÃ¡, Castellano, English)
            - El tema de les traduccions el veig complicat (sobretot pels spans que han de mostrar el nom del equip en mig d'una frase)
            - Lo millor seria crear un HTML per cada idioma??
        V Revisar tema movil, sobretot el touch, i veure que tots els menus no sobresurten de la pantalla
            V Touch revisat, ara sembla que funciona simulant desde el chrome.
        V Tinc 2 puntuacions per partida... en el UI i en Partida.Opciones.... i hi ha lio (si el poso a 100 i recarrego la pagina, mostra el 100, pero realment conta fins a 300)
        V Entre el moment que hi ha l'animaciÃ³ al colocar la ficha es pot posar una ficha com si no s'haques colocat la que s'esta animant
        V Hi ha algo raro amb les opcions, per exemple activa el AniTurno quan estÃ¡ desactivat (aquest cop no funcionarÃ¡, pero si fas un refresh a la pagina, funciona...)
        - Com no he aconseguit limitar la vista a landscape, he habilitat el modo portrait amb les seves mides... falta ajustar la cÃ mara 3d de l'escena
            - Una soluciÃ³ podria ser girar tot 45Âº de forma que es vegi tot, i tiris desde l'esquerra (pilotaÃ§o al canto amb els msgs de la UI) perÃ² m'agrada la idea.
        - Implementar espai / intro per continuar / acabar / comenÃ§ar (dels menÃºs)
        - Fer animaciÃ³ per sumar els punts de l'equip un cop acabada la ma


        0.999
            - Netejar / pulir / ampliar comentaris
        
*/

// Constructor
var DominoThree = function() {
    // Llamo al constructor del ObjetoBanner
    if (ObjetoCanvas.call(this, { 
        'Tipo'                      : 'THREE',
        'Ancho'                     : 'Auto',
        'Alto'                      : 'Auto',
        'Entorno'                   : 'Normal',
        'MostrarFPS'                : false,
        'BotonesPosicion'           : "derecha",         // Puede ser 'derecha' o 'izquierda'
        'BotonPantallaCompleta'     : false,        
        'BotonLogo'                 : false,
        'BotonExtraHTML'            : "",                // Contenido extra para los botones del lateral inferior izquierdo (solo se usa en el ejemplo sinusoidal y cyberparasit)
        'ElementoRaiz'              : "",                // ID de la etiqueta que se usara como raÃ­z para todo el HTML del objeto canvas. Si no se especifica ninguna, se usara el body.
        'Pausar'                    : false,             // Pausa el canvas si la pestaÃ±a no tiene el foco del teclado
        'ColorFondo'                : 0x2F354A,
        'CapturaEjemplo'            : "Domino.png",      // Captura de pantalla para el ejemplo a "NuevoCanvas2D.png" se le aÃ±adirÃ¡ "https://devildrey33.github.io/Graficos/250x200_"
        'ForzarLandscape'           : false              // Fuerza al dispositivo movil para que se muestre solo apaisado
    }) === false) { return false; }
    
    // VERSIÓN DEL JUEGO A MANO
    this.VersionDomino = "0.99.5d";
};

DominoThree.prototype = Object.assign( Object.create(ObjetoCanvas.prototype) , {
    constructor     : DominoThree, 
    EsMovilVisual   : false,
    EsPantallaMovil : function() {
        var maxTouch = (typeof(navigator) !== "undefined" && typeof(navigator.maxTouchPoints) === "number") ? navigator.maxTouchPoints : 0;
        var touch = ("ontouchstart" in window) || (maxTouch > 0);
        var smallViewport = Math.max(window.innerWidth || 0, window.innerHeight || 0) <= 1024;
        return (ObjetoNavegador.EsMovil() === true) || (touch && smallViewport);
    },
    // FunciÃ³n que se llama al redimensionar el documento
    Redimensionar   : function() {  
        if (typeof(this.Camara) === "undefined") return;
        this.EsMovilVisual = this.EsPantallaMovil();
        var portrait = (window.innerHeight > window.innerWidth);
        var mobileCameraBackOffset = 2.0;
        var distancia = 10;
        var altura = 10;
        var fov = 75;

        if (this.EsMovilVisual === true) {
            if (portrait) {
                distancia = 13.2 + mobileCameraBackOffset;
                altura = 8.9;
                fov = 72;
            }
            else {
                distancia = 9.4 + mobileCameraBackOffset;
                altura = 7.7;
                fov = 68;
            }
        }
        else if (portrait) {
            distancia = 18;
        }

        this.Camara.Rotacion.Distancia = distancia;
        this.Camara.fov = fov;
        this.Camara.updateProjectionMatrix();
        this.Camara.position.set(0, altura, this.Camara.Rotacion.Distancia);
        this.Camara.lookAt(this.Camara.Rotacion.MirarHacia);

        if (this.Context && typeof(this.Context.setPixelRatio) === "function") {
            var dpr = (typeof(window.devicePixelRatio) === "number" && window.devicePixelRatio > 0) ? window.devicePixelRatio : 1;
            var maxDpr = (this.EsMovilVisual === true) ? 1.15 : 2;
            this.Context.setPixelRatio(Math.min(dpr, maxDpr));
        }
    },
    // FunciÃ³n que se llama al hacer scroll en el documento    
    Scroll          : function() {    },
    // FunciÃ³n que se llama al mover el mouse por el canvas
    MouseMove       : function(Evento) { 
        this.MouseMovido = true;
        this.PosMouse.x = ( Evento.clientX / window.innerWidth ) * 2 - 1;
	this.PosMouse.y = - ( Evento.clientY / window.innerHeight ) * 2 + 1;
        this.ComprobarMouse();
    },
    // FunciÃ³n que se llama al presionar un botÃ³n del mouse por el canvas
    MousePresionado : function(Evento) { 
        this.ComprobarMouse();
    },
    // FunciÃ³n que se llama al soltar un botÃ³n del mouse por el canvas
    MouseSoltado    : function(Evento) { 
        this.Partida.JugadorColocar();
    },
    // FunciÃ³n que se llama al entrar con el mouse en el canvas
    MouseEnter      : function(Evento) { },
    // FunciÃ³n que se llama al salir con el mouse del canvas
    MouseLeave      : function(Evento) { },
    // FunciÃ³n que se llama al presionar la pantalla
    TouchStart      : function(Evento) { 
        this.MouseMovido = true;
        this.PosMouse.x =   ( Evento.touches[0].clientX / window.innerWidth ) * 2 - 1;
	this.PosMouse.y = - ( Evento.touches[0].clientY / window.innerHeight ) * 2 + 1;        
        this.ComprobarMouse();
//        this.Partida.JugadorColocar();
//        this.ComprobarMouse();
    },
    
    // FunciÃ³n que se llama al mover la presiÃ³n sobre la pantalla
    TouchMove      : function(Evento) { 
        this.MouseMovido = true;
        this.PosMouse.x =   ( Evento.touches[0].clientX / window.innerWidth ) * 2 - 1;
	this.PosMouse.y = - ( Evento.touches[0].clientY / window.innerHeight ) * 2 + 1;
//        this.ComprobarMouse();
    },    
    
    TouchEnd      : function(Evento) { 
/*        this.MouseMovido = true;
        this.PosMouse.x =   ( Evento.touches[0].clientX / window.innerWidth ) * 2 - 1;
	this.PosMouse.y = - ( Evento.touches[0].clientY / window.innerHeight ) * 2 + 1;        */
        this.Partida.JugadorColocar();
//        this.ComprobarMouse();
    },    
    // FunciÃ³n que se llama al presionar una tecla
    TeclaPresionada : function(Evento) { },
    // FunciÃ³n que se llama al soltar una tecla
    TeclaSoltada    : function(Evento) { },
    // FunciÃ³n que se llama al pausar el banner
    Pausa           : function() { },
    // FunciÃ³n que se llama al reanudar el banner
    Reanudar        : function() { },
//    Texturas        : new Domino_Texturas(),
    Partida         : new Domino_Partida(this),
    RayCaster       : new THREE.Raycaster(),
    PosMouse        : new THREE.Vector2(),
    PlanoJuego      : new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
    PuntoDrag       : new THREE.Vector3(),
    DragActiva      : false,
    DragInfo        : { idx : -1, rama : "", ox : 0, oz : 0 },
//    Opciones        : new Domino_Opciones(),
    
    // FunciÃ³n que inicia el ejemplo
    Iniciar         : function() {       
        // Esconde la ventana que informa al usuario de que se estÃ¡ cargando la animaciÃ³n. (REQUERIDO)
        this.Cargando(false);        
        
        // VERSIÃN DEL JUEGO A MANO
        document.getElementById("VersionDomino").innerHTML = this.VersionDomino;
        
        // Fijo el modo landscape (NO VA...)
//        screen.orientation.lock("landscape");

        // Fuerzo a recargar todo el contenido (NO VA...)
        // Al StackOverflow es comenta que si fas "Request desktop site" es fa un hard reload inclus dels CSS
        // I si no.. amb el movil enxufat al PC Cmd+Shift+R...
        // Una altre solucio es afegir/modificar un parÃ¡metre get al link : ej: www.url.com/?a=1
        //window.location.reload(true);
        
        this.EsMovilVisual = this.EsPantallaMovil();
        // Activo el mapeado de sombras
        this.Context.shadowMap.enabled	= true;
        this.Context.shadowMap.type = (this.EsMovilVisual === true) ? THREE.BasicShadowMap : THREE.PCFSoftShadowMap;
        // Creo la escena
        this.Escena = new THREE.Scene();
        // Creo la camara
        this.Camara = new THREE.PerspectiveCamera(75, this.Ancho / this.Alto, 0.5, 1000);
        this.Camara.Rotacion = { Grados : 0, Avance : (Math.PI / 180) / 1.5, Distancia : 7, MirarHacia : new THREE.Vector3(0, 0, 0), Animacion : true };
        this.Camara.position.set(0, 10, this.Camara.Rotacion.Distancia);        
        
        // FunciÃ³n para que la cÃ¡mara rote alrededor de la escena
/*        this.Camara.Rotar = function() {
            if (this.Rotacion.Animacion === true) {
                this.Rotacion.Grados += this.Rotacion.Avance;
                this.position.x = this.Rotacion.Distancia * Math.cos(this.Rotacion.Grados);
                this.position.z = this.Rotacion.Distancia * Math.sin(this.Rotacion.Grados);
                this.lookAt(this.Rotacion.MirarHacia); 
            }
        };*/
        this.Escena.add(this.Camara);
        this.Camara.lookAt(this.Camara.Rotacion.MirarHacia); 

        // Plano de suelo con look glass/neumorphism
        this.Suelo = new THREE.Mesh(
            new THREE.PlaneGeometry(300, 300),
            new THREE.MeshPhongMaterial({
                color: 0x3f4766,
                specular: 0xffffff,
                shininess: 85,
                emissive: 0x12182a,
                transparent: true,
                opacity: 0.94
            })
        );
        this.Suelo.rotation.x = -Math.PI / 2;
        this.Suelo.position.y = -0.2;
        //this.Suelo.position.x = -25;
        this.Suelo.position.z = 15;
        this.Suelo.castShadow = false;
        this.Suelo.receiveShadow = true;
        this.Escena.add(this.Suelo);

        // Inicio las texturas del domino
        Texturas.Iniciar();

        this.CrearLuces();
        this.Partida.Opciones.Iniciar();
        UI.Iniciar();
        
        this.Redimensionar();
//        this.Camara.Rotar();
        setTimeout(this.Partida.CrearFichas.bind(this.Partida), 10);
    },

    ObtenerFichaHoverLocal : function() {
        var Seat = (typeof(this.Partida.LocalSeat) === "number") ? this.Partida.LocalSeat : 0;
        var Ini = Seat * 7;
        for (var i = 0; i < 7; i++) {
            var idx = Ini + i;
            if (this.Partida.Ficha[idx].Colocada === false && this.Partida.Ficha[idx].Hover > 0) return idx;
        }
        return -1;
    },

    RamaDrag : function() {
        if (typeof(this.Partida.FichaIzquierda.Ficha) === "undefined" || typeof(this.Partida.FichaDerecha.Ficha) === "undefined") return "";
        var dxI = this.PuntoDrag.x - this.Partida.FichaIzquierda.Ficha.position.x;
        var dzI = this.PuntoDrag.z - this.Partida.FichaIzquierda.Ficha.position.z;
        var dxD = this.PuntoDrag.x - this.Partida.FichaDerecha.Ficha.position.x;
        var dzD = this.PuntoDrag.z - this.Partida.FichaDerecha.Ficha.position.z;
        var DistI = (dxI * dxI) + (dzI * dzI);
        var DistD = (dxD * dxD) + (dzD * dzD);
        return (DistI <= DistD) ? "izquierda" : "derecha";
    },

    DragStart : function() {
        if (this.Partida.EsTurnoHumanoLocal() === false) return;
        var idx = this.ObtenerFichaHoverLocal();
        if (idx < 0) return;
        var Ramas = this.Partida.RamasDisponiblesFicha(idx);
        if (Ramas.length !== 2) return;

        this.DragActiva = true;
        this.DragInfo.idx = idx;
        this.DragInfo.ox = this.Partida.Ficha[idx].Ficha.position.x;
        this.DragInfo.oz = this.Partida.Ficha[idx].Ficha.position.z;
        this.DragInfo.rama = "";
    },

    DragMove : function() {
        if (this.DragActiva === false || this.DragInfo.idx < 0) return;
        this.RayCaster.setFromCamera(this.PosMouse, this.Camara);
        if (this.RayCaster.ray.intersectPlane(this.PlanoJuego, this.PuntoDrag) === null) return;

        var F = this.Partida.Ficha[this.DragInfo.idx].Ficha;
        F.position.set(this.PuntoDrag.x, F.position.y, this.PuntoDrag.z);
        this.DragInfo.rama = this.RamaDrag();
    },

    DragEnd : function() {
        if (this.DragActiva === false) return;
        var idx = this.DragInfo.idx;
        var rama = this.DragInfo.rama;
        this.DragActiva = false;

        if (idx >= 0 && typeof(this.Partida.Ficha[idx]) !== "undefined") {
            var F = this.Partida.Ficha[idx].Ficha;
            if (this.Partida.PuedeJugarEnRama(idx, rama) === true) {
                this.Partida.JugadorColocar(idx, rama);
            }
            else {
                F.position.set(this.DragInfo.ox, F.position.y, this.DragInfo.oz);
                // Si le joueur n'a pas déposé clairement la tuile vers une extrémité,
                // on annule simplement l'action au lieu d'auto-choisir une branche.
            }
        }

        this.DragInfo.idx = -1;
        this.DragInfo.rama = "";
    },
    
    
    CrearLuces : function() {
        // Luz de ambiente  
        this.HemiLight = new THREE.HemisphereLight( 0xeeeeee, 0xffffff, 0.7 );
        this.HemiLight.color.setHSL( 0.6, 0.6, 0.6 );
        this.HemiLight.groundColor.setHSL( 0.095, 1, 0.75 );
        this.HemiLight.position.set( 0, 0, 0 );
        this.Escena.add( this.HemiLight );                 
    },
        
    // Mantiene la orientacion de la camara del turno sin desplazar la luz direccional.
    AnimarLuz       : function(NumJugador) {
        if (typeof(this.AniLuz) !== "undefined") {
            this.AniLuz.Terminar();
        }
        var PosX = 0;
        var PosZ = 0;
        var RotZ = 0;
        switch (NumJugador) {
            case 0 :    // Abajo
                PosZ = -25;
                PosX = 0;
                break;
            case 1 :    // Derecha
                PosZ = -30;
                PosX = 30;
                RotZ = -Math.PI / 128;
                break;
            case 2 :    // Arriba
                PosZ = -50;
                PosX = 0;
                break;
            case 3 :    // Izquierda
                PosZ = -30;
                PosX = -30;
                RotZ = Math.PI / 128;
                break;
        }
        this.AniLuz = Animaciones.CrearAnimacion([
                    { Paso : { RZ : this.Camara.rotation.y } },
                    { Paso : { RZ : RotZ }, Tiempo : 400, FuncionTiempo : FuncionesTiempo.SinInOut }
            ], { FuncionActualizar : function(Valores) { 
                    this.Camara.rotation.y = Valores.RZ;
                    this.Camara.lookAt(this.Camara.Rotacion.MirarHacia);
            }.bind(this) });
        this.AniLuz.Iniciar();
    },
    
    
    ComprobarMouse  : function() {
        if (this.MouseMovido === false) return;
        if (this.DragActiva === true) return;
        if (typeof(this.Partida.Ficha[0]) === "undefined") return;
        
        
        this.RayCaster.setFromCamera(this.PosMouse, this.Camara);
        var intersects = this.RayCaster.intersectObjects( this.Escena.children, true );        
        var Hover = [ 0, 0, 0, 0, 0, 0, 0 ];
        var LocalSeat = (typeof(this.Partida.LocalSeat) === "number") ? this.Partida.LocalSeat : 0;
        var Ini = LocalSeat * 7;
        
        
        // Compruebo si hay que hacer hover en alguna de las fichas del jugador local
        for (var i = 0; i < intersects.length; i++ ) {
            for (var f = 0; f < 7; f++) {
                var idx = Ini + f;
                if (intersects[i].object === this.Partida.Ficha[idx].Cara1 && this.Partida.Ficha[idx].Colocada === false) {
                    Hover[f] = 1;
                }
                if (intersects[i].object === this.Partida.Ficha[idx].Cara2 && this.Partida.Ficha[idx].Colocada === false) {
                    Hover[f] = 2;
                }
                if (intersects[i].object === this.Partida.Ficha[idx].Bola && this.Partida.Ficha[idx].Colocada === false) {
                    Hover[f] = 3;
                }                
            }        
        }
        
        // Miro si hay algun cambio respecto los hovers (siempre que sea el turno local)
        if (this.Partida.JugadorActual === LocalSeat) {        
            for (var f = 0; f < 7; f++) {
                var idx = Ini + f;
                if (Hover[f] !== this.Partida.Ficha[idx].Hover) {
                    this.Partida.Ficha[idx].AsignarHover(Hover[f]);
                }
            }
        }
    },
        
    
    // FunciÃ³n que pinta cada frame de la animaciÃ³n
    Pintar          : function() {  
        this.ComprobarMouse();
        
        Animaciones.Actualizar();
        
        //this.Camara.Rotar();
        this.Context.render(this.Escena, this.Camara);  
    }
});

// InicializaciÃ³n del canvas en el Load de la pÃ¡gina
//var Domino = {};
//window.addEventListener('load', function() { Domino = new DominoThree; });

var Domino = new DominoThree;
