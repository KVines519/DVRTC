#!/bin/bash

compose_common_init() {
    local repo_root="$1"

    COMPOSE_REPO_ROOT="$repo_root"
    COMPOSE_DIR="$repo_root/compose"
    ENV_FILE="$repo_root/.env"
    PROJECT_DIRECTORY="$repo_root"
    BASE_COMPOSE_FILE="$COMPOSE_DIR/base.yml"
    BASE_DEV_COMPOSE_FILE="$COMPOSE_DIR/dev.yml"
}

compose_resolve_scenario() {
    local scenario="$1"

    case "$scenario" in
        pbx1|pbx2|conferencing1)
            SCENARIO="$scenario"
            SCENARIO_COMPOSE_FILE="$COMPOSE_DIR/${scenario}.yml"
            SCENARIO_DEV_COMPOSE_FILE="$COMPOSE_DIR/dev.${scenario}.yml"
            PROJECT_NAME="dvrtc-${scenario}"
            OTHER_SCENARIOS=""
            for candidate in pbx1 pbx2 conferencing1; do
                if [ "$candidate" != "$scenario" ]; then
                    OTHER_SCENARIOS="${OTHER_SCENARIOS} ${candidate}"
                fi
            done
            ;;
        *)
            echo "ERROR: Unknown scenario: $scenario" >&2
            return 1
            ;;
    esac
}

compose_extract_subcommand() {
    local skip_next=0
    local token

    COMPOSE_SUBCOMMAND=""
    for token in "$@"; do
        if [ "$skip_next" -eq 1 ]; then
            skip_next=0
            continue
        fi
        case "$token" in
            --profile|--file|-f|--project-name|-p|--env-file)
                skip_next=1
                ;;
            --profile=*|--file=*|--project-name=*|--env-file=*)
                ;;
            -*)
                ;;
            *)
                COMPOSE_SUBCOMMAND="$token"
                return 0
                ;;
        esac
    done
}

compose_append_remove_orphans_for_up() {
    local token

    if [ "${COMPOSE_SUBCOMMAND:-}" != "up" ]; then
        return 0
    fi

    for token in "${FINAL_ARGS[@]}"; do
        if [ "$token" = "--remove-orphans" ]; then
            return 0
        fi
    done

    FINAL_ARGS+=("--remove-orphans")
}

compose_cleanup_other_scenarios() {
    local include_dev="${1:-0}"
    local legacy_current_compose_cmd=(
        docker compose
        --env-file "$ENV_FILE"
        --project-directory "$PROJECT_DIRECTORY"
        -p "dvrtc"
        -f "$BASE_COMPOSE_FILE"
        -f "$SCENARIO_COMPOSE_FILE"
    )
    local other
    local other_compose_file
    local other_dev_compose_file
    local other_compose_cmd

    if [ "$include_dev" = "1" ]; then
        legacy_current_compose_cmd+=(-f "$BASE_DEV_COMPOSE_FILE" -f "$SCENARIO_DEV_COMPOSE_FILE")
    fi

    for other in $OTHER_SCENARIOS; do
        other_compose_file="$COMPOSE_DIR/${other}.yml"
        other_dev_compose_file="$COMPOSE_DIR/dev.${other}.yml"
        other_compose_cmd=(
            docker compose
            --env-file "$ENV_FILE"
            --project-directory "$PROJECT_DIRECTORY"
            -p "dvrtc-${other}"
            -f "$BASE_COMPOSE_FILE"
            -f "$other_compose_file"
        )
        if [ "$include_dev" = "1" ]; then
            other_compose_cmd+=(-f "$BASE_DEV_COMPOSE_FILE" -f "$other_dev_compose_file")
        fi

        "${other_compose_cmd[@]}" down --remove-orphans >/dev/null 2>&1 || true
    done

    "${legacy_current_compose_cmd[@]}" down --remove-orphans >/dev/null 2>&1 || true
    for other in $OTHER_SCENARIOS; do
        other_compose_file="$COMPOSE_DIR/${other}.yml"
        other_dev_compose_file="$COMPOSE_DIR/dev.${other}.yml"
        other_compose_cmd=(
            docker compose
            --env-file "$ENV_FILE"
            --project-directory "$PROJECT_DIRECTORY"
            -p "dvrtc"
            -f "$BASE_COMPOSE_FILE"
            -f "$other_compose_file"
        )
        if [ "$include_dev" = "1" ]; then
            other_compose_cmd+=(-f "$BASE_DEV_COMPOSE_FILE" -f "$other_dev_compose_file")
        fi

        "${other_compose_cmd[@]}" down --remove-orphans >/dev/null 2>&1 || true
    done
}
