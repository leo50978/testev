/* 
    Domino ThreeJS creado por Josep Antoni Bover Comas el 20/01/2019

        Objeto que controla el interfaz de usuario HTML del juego

        Vista por defecto en el Laboratorio de pruebas  
		devildrey33_Lab->Opciones->Vista = Filas;

        Ultima modificaciÃ³n el 25/02/2019
*/

var Domino_UI = function() {
    
    this.PuntuacionPorPartida = 300; // Por defecto las partidas son de 300 puntos
    
    this.Iniciar = function() {
        
        // Modo solo: oculto configuracion de equipos
        document.getElementById("BotonEquipos").style.display = "none";
        document.getElementById("MarcoEquipos").style.display = "none";
        document.getElementById("NombreEquipo1").parentNode.style.display = "none";
        document.getElementById("NombreEquipo2").parentNode.style.display = "none";
        // Boton Opciones
        document.getElementById("BotonOpciones").onclick = function() {
            UI.OcultarEmpezar();
            UI.MostrarOpciones();
        };
        
        // Boton Cerrar Equipos
        document.getElementById("BotonCerrarEquipos").onclick = function() {
            UI.OcultarEquipos();
            UI.MostrarEmpezar();
        };
        // Boton Cerrar Opciones
        document.getElementById("BotonCerrarOpciones").onclick = function() {
            UI.OcultarOpciones();
            UI.MostrarEmpezar();
        };
        
        // Boton empezar
        document.getElementById("BotonEmpezar").onclick = function() {
            Domino.Partida.Empezar();
        };
        // Boton continuar (victoria / derrota)
        document.getElementById("BotonContinuar").onclick = function() {
            Domino.Partida.Continuar();
        };
        // Boton continuar empate
        document.getElementById("BotonContinuar2").onclick = function() {
            Domino.Partida.Continuar();
        };
        // Boton terminar la partida
        document.getElementById("BotonTerminar").onclick = async function() {
            if (window.LogiqueJeu && typeof window.LogiqueJeu.endGameClick === "function") {
                var Res = await window.LogiqueJeu.endGameClick();
                if (Res === "deleted" || Res === "no_room") {
                    UI.OcultarGanador();
                    UI.MostrarEmpezar();
                }
                return;
            }
            UI.OcultarGanador();
            UI.MostrarEmpezar();
        };
        
        
        // Editar Equipo
        // Edit del nombre del equipo 1
        document.getElementById("NEquipo1").onchange = function() {
            Domino.Partida.Opciones.AsignarNombreEquipo("1", document.getElementById("NEquipo1").value);
        };

        // Edit del nombre del equipo 2
        document.getElementById("NEquipo2").onchange = function() {
            Domino.Partida.Opciones.AsignarNombreEquipo("2", document.getElementById("NEquipo2").value);
        };
        
        // Edit del nombre del jugador 1
        document.getElementById("NNombre1").onchange = function() {
            Domino.Partida.Opciones.AsignarNombreJugador("1", document.getElementById("NNombre1").value);
        };

        // Edit del nombre del jugador 2
        document.getElementById("NNombre2").onchange = function() {
            Domino.Partida.Opciones.AsignarNombreJugador("2", document.getElementById("NNombre2").value);
        };
        
        // Edit del nombre del jugador 3
        document.getElementById("NNombre3").onchange = function() {
            Domino.Partida.Opciones.AsignarNombreJugador("3", document.getElementById("NNombre3").value);
        };
        
        // Edit del nombre del jugador 4
        document.getElementById("NNombre4").onchange = function() {
            Domino.Partida.Opciones.AsignarNombreJugador("4", document.getElementById("NNombre4").value);
        };
        
        
        // Opciones
        // Checkbox Jugar al descubierto
        document.getElementById("Opciones_Descubierto").onclick = function() {
            Domino.Partida.Opciones.AsignarDescubierto(document.getElementById("Opciones_Descubierto").checked);
        };
        
        // CheckBox animar turno en 3d
        document.getElementById("Opciones_AnimarTurno").onclick = function() {
            Domino.Partida.Opciones.AsignarAniTurno(document.getElementById("Opciones_AnimarTurno").checked);
        };
        
        // Checkbox ayuda para el jugador
        document.getElementById("Opciones_Ayuda").onclick = function() {
            Domino.Partida.Opciones.AsignarAyuda(document.getElementById("Opciones_Ayuda").checked);
        };
        
        // Botones para cambiar el idioma
        // Boton English
        document.getElementById("Idioma_en").onclick = function() {
            Domino.Partida.Opciones.AsignarIdioma('en');
            document.getElementById('Idioma_en').className  = "IdiomaMarcado";
            document.getElementById('Idioma_cat').className = "";
            document.getElementById('Idioma_es').className  = "";
        };
        // Boton Català
        document.getElementById("Idioma_cat").onclick = function() {
            Domino.Partida.Opciones.AsignarIdioma('cat');
            document.getElementById('Idioma_en').className  = "";
            document.getElementById('Idioma_cat').className = "IdiomaMarcado";
            document.getElementById('Idioma_es').className  = "";
        };
        // Boton Castellano
        document.getElementById("Idioma_es").onclick = function() {
            Domino.Partida.Opciones.AsignarIdioma('es');
            document.getElementById('Idioma_en').className  = "";
            document.getElementById('Idioma_cat').className = "";
            document.getElementById('Idioma_es').className  = "IdiomaMarcado";
        };
        
        
        // Modo solo: no hay objetivo por puntos
        document.getElementById("BloquePuntosPartida").style.display = "none";
                
        this.MostrarEmpezar();
    };
    
    // Mostrar menú para empezar una partida
    this.MostrarEmpezar = function() {
        document.getElementById("MarcoEmpezar").setAttribute("visible", "true");
    };
    
    // Mostrar menu para ocultar una partida
    this.OcultarEmpezar = function() {
        document.getElementById("MarcoEmpezar").setAttribute("visible", "false");
    };

    // Mostrar menu para editar los equipos
    this.MostrarEquipos = function() {
        document.getElementById("MarcoEquipos").setAttribute("visible", "true");
    };
    
    // Mostrar menu para ocultar el menú para editar equipos
    this.OcultarEquipos = function() {
        document.getElementById("MarcoEquipos").setAttribute("visible", "false");
    };
    
    // Mostrar menu para editar las opciones
    this.MostrarOpciones = function() {
        document.getElementById("MarcoOpciones").setAttribute("visible", "true");
    };
    
    // Mostrar menu para ocultar el menú de las opciones
    this.OcultarOpciones = function() {
        document.getElementById("MarcoOpciones").setAttribute("visible", "false");
    };
    
    
    // Mostrar menu para continuar una partida
    this.MostrarContinuar = function(Equipo, Puntos, P1, P2, P3, P4) {
        
        document.getElementById("PG_Puntos").innerHTML = Puntos;
        document.getElementById("MV_P1").innerHTML = P1;
        document.getElementById("MV_P2").innerHTML = P2;
        document.getElementById("MV_P3").innerHTML = P3;
        document.getElementById("MV_P4").innerHTML = P4;
        document.getElementById("MV_P13").innerHTML = P1 + P3;
        document.getElementById("MV_P24").innerHTML = P2 + P4;
        
        // Nombres de los jugadores y equipos
        document.getElementById("MV_E1").innerHTML = Domino.Partida.Opciones.NombreEquipo[0];
        document.getElementById("MV_E2").innerHTML = Domino.Partida.Opciones.NombreEquipo[1];
        document.getElementById("MVN_P1").innerHTML = Domino.Partida.Opciones.NombreJugador[0];
        document.getElementById("MVN_P2").innerHTML = Domino.Partida.Opciones.NombreJugador[1];
        document.getElementById("MVN_P3").innerHTML = Domino.Partida.Opciones.NombreJugador[2];
        document.getElementById("MVN_P4").innerHTML = Domino.Partida.Opciones.NombreJugador[3];
        
        if (Equipo === "1") {   // Gana el equipo 1
            document.getElementById("PG_Equipo").innerHTML = Domino.Partida.Opciones.NombreEquipo[0];
            document.getElementById("MV_E1").className = "Empate_Victoria";
            document.getElementById("MV_E2").className = "Empate_Derrota";
        }
        else {                          // Gana el equipo 2
            document.getElementById("PG_Equipo").innerHTML = Domino.Partida.Opciones.NombreEquipo[1];
            document.getElementById("MV_E1").className = "Empate_Derrota";
            document.getElementById("MV_E2").className = "Empate_Victoria";
        }        

        document.getElementById("MarcoContinuar").setAttribute("visible", "true");        
    };
        
    this.OcultarContinuar = function() {
        document.getElementById("MarcoContinuar").setAttribute("visible", "false");
    };
    
    // Mostrar menu para continuar una partida
    this.MostrarEmpate = function(P1, P2, P3, P4) {
        document.getElementById("ME_P1").innerHTML = P1;
        document.getElementById("ME_P2").innerHTML = P2;
        document.getElementById("ME_P3").innerHTML = P3;
        document.getElementById("ME_P4").innerHTML = P4;
        document.getElementById("ME_P13").innerHTML = P1 + P3;
        document.getElementById("ME_P24").innerHTML = P2 + P4;
        
        // Nombres de los jugadores y equipos
        document.getElementById("ME_E1").innerHTML = Domino.Partida.Opciones.NombreEquipo[0];
        document.getElementById("ME_E2").innerHTML = Domino.Partida.Opciones.NombreEquipo[1];
        document.getElementById("MEN_P1").innerHTML = Domino.Partida.Opciones.NombreJugador[0];
        document.getElementById("MEN_P2").innerHTML = Domino.Partida.Opciones.NombreJugador[1];
        document.getElementById("MEN_P3").innerHTML = Domino.Partida.Opciones.NombreJugador[2];
        document.getElementById("MEN_P4").innerHTML = Domino.Partida.Opciones.NombreJugador[3];
        
        
        var Equipo = 0;
        if (P1 + P3 === P2 + P4) {
            document.getElementById("ME_E1").className = "Empate_Derrota";
            document.getElementById("ME_E2").className = "Empate_Derrota";
        }
        else if (P1 + P3 < P2 + P4) {   // Gana el equipo 1 por sumar menos puntos
            document.getElementById("ME_E1").className = "Empate_Victoria";
            document.getElementById("ME_E2").className = "Empate_Derrota";
            Equipo = 1;
        }
        else {                          // Gana el equipo 2 por sumar menos puntos
            document.getElementById("ME_E1").className = "Empate_Derrota";
            document.getElementById("ME_E2").className = "Empate_Victoria";
            Equipo = 2;
        }
        
        if (Equipo === 0) { // Empate
            document.getElementById("TxtVictoria").style.display = "none";
            document.getElementById("TxtEmpate").style.display = "table";
        }
        else { // Victoria de un equipo
            document.getElementById("TxtVictoriaPuntos").innerHTML = P1 + P2 + P3 + P4;
            document.getElementById("TxtVictoriaEquipo").innerHTML = Domino.Partida.Opciones.NombreEquipo[Equipo - 1];  
            document.getElementById("TxtVictoria").style.display = "table";
            document.getElementById("TxtEmpate").style.display = "none";  
        }
        
        document.getElementById("MarcoEmpate").setAttribute("visible", "true");
        
    };
        
    this.OcultarEmpate = function() {
        document.getElementById("MarcoEmpate").setAttribute("visible", "false");
    };
    
    this.AsignarPuntuacionPorPartida = function(Puntos) {
        for (var i = 1; i < 7; i++) {
            document.getElementById("Puntos" + i * 100).className = "";
        }
        document.getElementById("Puntos" + Puntos).className = "PuntosMarcados";
        this.PuntuacionPorPartida = Puntos;
        Domino.Partida.Opciones.AsignarPuntosPorPartida(Puntos);
    };
    
    // Función que refresca los datos de la mano, en el div superior izquierdo.
    this.MostrarDatosMano = function() {
        document.getElementById("DatosJuego").setAttribute("Visible", "true");
        document.getElementById("NombreEquipo1").innerHTML = "";
        document.getElementById("NombreEquipo2").innerHTML = "";
        document.getElementById("Equipo1").innerHTML = "";
        document.getElementById("Equipo2").innerHTML = "";
        // Si no es un dispositivo móvil, muestro el historial de tiradas en un div superior derecho.
        if (ObjetoNavegador.EsMovil() === false) {
            document.getElementById("Historial").setAttribute("Visible", "true");
        }
    };
    
    this.OcultarDatosMano = function() {
        document.getElementById("DatosJuego").setAttribute("Visible", "false");
        document.getElementById("Historial").setAttribute("Visible", "false");
    };
    
    this.MostrarGanador = function (GanadorSeat, Motif, Options)  {
        var WinnerSeat = (typeof(GanadorSeat) === "number") ? GanadorSeat : 0;
        var Opts = (Options && typeof(Options) === "object") ? Options : {};
        var ServerConfirmed = (Opts.serverConfirmed === true);
        var Rnd = Math.floor(10000 + Math.random() * 90000);
        try {
            var Partida = (window.Domino && window.Domino.Partida) ? window.Domino.Partida : null;
            var PayloadWinner = {
                ts: new Date().toISOString(),
                winnerSeat: WinnerSeat,
                motif: Motif || "",
                serverConfirmed: ServerConfirmed,
                hasPartida: !!Partida,
                siguienteAccionSeq: Partida ? Partida.SiguienteAccionSeq : -1,
                manoTerminada: Partida ? Partida.ManoTerminada : false,
                hayAnimacionColocar: Partida && typeof(Partida.HayAnimacionColocarActiva) === "function" ? Partida.HayAnimacionColocarActiva() : false
            };
            console.log("[DOMINO_UI_DEBUG] MostrarGanador " + JSON.stringify(PayloadWinner), PayloadWinner);
        } catch (_) {
        }

        var Overlay = document.getElementById("GameEndOverlay");
        var WinnerEl = document.getElementById("GameEndWinnerText");
        var InfoEl = document.getElementById("GameEndInfoText");
        var Trophy = document.getElementById("GameEndTrophy");
        var ViewWrap = document.getElementById("GameEndViewWrap");
        var ViewBtn = document.getElementById("GameEndViewTableBtn");
        var ActionsWrap = document.getElementById("GameEndActionsWrap");
        var GoBtn = document.getElementById("GameEndGoBtn");
        var ReplayBtn = document.getElementById("GameEndReplayBtn");
        var BackBtn = document.getElementById("GameEndBackBtn");

        var IsLocalWinner = false;
        if (window.Domino && window.Domino.Partida && typeof(window.Domino.Partida.LocalSeat) === "number") {
            IsLocalWinner = (window.Domino.Partida.LocalSeat === WinnerSeat);
        }
        var WinnerText = (IsLocalWinner === true)
            ? "Tu as gagné"
            : ("Joueur id-" + Rnd + " a gagné");

        if (WinnerEl) WinnerEl.innerHTML = WinnerText;
        if (InfoEl) InfoEl.innerHTML = "Regarde la table puis clique sur Voir la table.";

        if (Trophy) {
            if (IsLocalWinner === true) {
                Trophy.classList.remove("hidden");
                Trophy.style.opacity = "0";
                Trophy.style.transform = "translateY(140px) scale(0.55)";
            }
            else {
                Trophy.classList.add("hidden");
                Trophy.style.opacity = "1";
                Trophy.style.transform = "translateY(0) scale(1)";
            }
        }

        if (ReplayBtn && ReplayBtn.dataset.bound !== "1") {
            ReplayBtn.dataset.bound = "1";
            ReplayBtn.onclick = function() {
                window.location.href = "./jeu.html?autostart=1";
            };
        }

        if (BackBtn && BackBtn.dataset.bound !== "1") {
            BackBtn.dataset.bound = "1";
            BackBtn.onclick = function() {
                window.location.href = "./inedex.html";
            };
        }

        if (GoBtn && GoBtn.dataset.bound !== "1") {
            GoBtn.dataset.bound = "1";
            GoBtn.onclick = async function() {
                GoBtn.disabled = true;
                GoBtn.textContent = "Sortie...";
                if (InfoEl) InfoEl.innerHTML = "Sortie de la salle en cours...";
                if (window.LogiqueJeu && typeof window.LogiqueJeu.endGameClick === "function") {
                    var Res = await window.LogiqueJeu.endGameClick();
                    if (Res === "left" || Res === "deleted" || Res === "no_room") {
                        UI.NotifierSalleSupprimee();
                    }
                    else {
                        if (InfoEl) InfoEl.innerHTML = "Impossible de quitter la salle. Réessaie.";
                        GoBtn.disabled = false;
                        GoBtn.textContent = "Aller";
                    }
                }
            };
        }
        if (ViewBtn && ViewBtn.dataset.bound !== "1") {
            ViewBtn.dataset.bound = "1";
            ViewBtn.onclick = function() {
                if (Overlay) {
                    Overlay.classList.add("hidden");
                    Overlay.classList.remove("flex");
                }
                if (GoBtn) {
                    GoBtn.classList.remove("hidden");
                    GoBtn.classList.add("block");
                    GoBtn.disabled = false;
                    GoBtn.textContent = "Aller";
                }
                if (InfoEl) InfoEl.innerHTML = "Clique sur Aller quand tu es prêt.";
            };
        }

        if (ViewWrap) {
            ViewWrap.classList.add("hidden");
            ViewWrap.classList.remove("block");
        }
        if (ActionsWrap) {
            ActionsWrap.classList.add("hidden");
            ActionsWrap.classList.remove("grid");
        }
        if (GoBtn) {
            GoBtn.classList.add("hidden");
            GoBtn.classList.remove("block");
            GoBtn.disabled = false;
            GoBtn.textContent = "Aller";
        }

        if (Overlay) {
            Overlay.classList.add("hidden");
            Overlay.classList.remove("flex");
        }

        if (window.Domino && window.Domino.Partida && window.Domino.Partida.Multijugador === true && ServerConfirmed !== true) {
            if (InfoEl) InfoEl.innerHTML = "Fin de partie détectée. Validation serveur en cours...";
            document.getElementById("MarcoTerminado").setAttribute("visible", "false");
            if (window.LogiqueJeu && typeof window.LogiqueJeu.onGameEnded === "function") {
                window.LogiqueJeu.onGameEnded(WinnerSeat);
            }
            return;
        }

        clearTimeout(this._WinnerOverlayTimer || 0);
        this._WinnerOverlayTimer = setTimeout(function() {
            if (!Overlay) return;
            Overlay.classList.remove("hidden");
            Overlay.classList.add("flex");

            if (IsLocalWinner === true && Trophy) {
                Trophy.classList.remove("hidden");
                Trophy.animate([
                    { transform: "translateY(140px) scale(0.55)", opacity: 0 },
                    { transform: "translateY(-8px) scale(1.08)", opacity: 1, offset: 0.82 },
                    { transform: "translateY(0) scale(1)", opacity: 1 }
                ], {
                    duration: 950,
                    easing: "cubic-bezier(0.22, 1, 0.36, 1)",
                    fill: "forwards"
                });
                setTimeout(function() {
                    if (!ViewWrap) return;
                    ViewWrap.classList.remove("hidden");
                    ViewWrap.classList.add("block");
                }, 980);
            }
            else {
                if (ViewWrap) {
                    ViewWrap.classList.remove("hidden");
                    ViewWrap.classList.add("block");
                }
            }
        }, 2400);

        document.getElementById("MarcoTerminado").setAttribute("visible", "false");

        if (ServerConfirmed !== true && window.LogiqueJeu && typeof window.LogiqueJeu.onGameEnded === "function") {
            window.LogiqueJeu.onGameEnded(WinnerSeat);
        }
    };

    this.NotifierSalleSupprimee = function() {
        var ViewWrap = document.getElementById("GameEndViewWrap");
        var ActionsWrap = document.getElementById("GameEndActionsWrap");
        var InfoEl = document.getElementById("GameEndInfoText");
        var Overlay = document.getElementById("GameEndOverlay");
        var GoBtn = document.getElementById("GameEndGoBtn");
        if (ViewWrap) {
            ViewWrap.classList.add("hidden");
            ViewWrap.classList.remove("block");
        }
        if (ActionsWrap) {
            ActionsWrap.classList.remove("hidden");
            ActionsWrap.classList.add("grid");
        }
        if (GoBtn) {
            GoBtn.classList.add("hidden");
            GoBtn.classList.remove("block");
        }
        if (InfoEl) InfoEl.innerHTML = "Tu peux continuer. Les autres joueurs peuvent terminer de leur cote.";
        if (Overlay) {
            Overlay.classList.remove("hidden");
            Overlay.classList.add("flex");
        }
    };

    this.MostrarPassVisual = function() {
        var Pass = document.getElementById("PassVisual");
        if (!Pass) return;
        Pass.classList.remove("hidden");
        Pass.classList.add("block");
        clearTimeout(this._PassTimer || 0);
        this._PassTimer = setTimeout(function() {
            Pass.classList.add("hidden");
            Pass.classList.remove("block");
        }, 900);
    };
    
    this.OcultarGanador = function ()  {
        document.getElementById("MarcoTerminado").setAttribute("visible", "false");
        var Overlay = document.getElementById("GameEndOverlay");
        var GoBtn = document.getElementById("GameEndGoBtn");
        if (Overlay) {
            Overlay.classList.add("hidden");
            Overlay.classList.remove("flex");
        }
        if (GoBtn) {
            GoBtn.classList.add("hidden");
            GoBtn.classList.remove("block");
        }
    };
    
    this.MostrarVictoria = function() {
        document.getElementById("VictoriaDerrota").innerHTML = "<div id='Victoria'><img src='./Partida.svg#Ganada' /></div>";
    };
    
    this.MostrarDerrota = function() {
        document.getElementById("VictoriaDerrota").innerHTML = "<div id='Derrota'><img src='./Partida.svg#Perdida' /></div>";        
    };
    
    this.MostrarPartidaGanada = function() {
        document.getElementById("VictoriaDerrota").innerHTML = "<div id='ParitdaGanada'><img src='./PartidaGanada.svg' /></div>";
    };
    
    this.MostrarPartidaPerdida = function() {
        this.MostrarDerrota();
        //document.getElementById("VictoriaDerrota").innerHTML = "<div id='Derrota'><img src='./Partida.svg#Perdida' /></div>";
    };
            
};

var UI = new Domino_UI();
